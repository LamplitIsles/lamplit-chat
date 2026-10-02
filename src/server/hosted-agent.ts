import { Agent, callable, getCurrentAgent } from 'agents'

type HostedConnectionState = { tokenHash?: string }

export class HostedAgent extends Agent<Env> {
  closeSessionConnections(tokenHash: string): void {
    for (const connection of this.getConnections<HostedConnectionState>()) {
      if (connection.state?.tokenHash === tokenHash) connection.close(1008, 'Session ended')
    }
  }
  async onConnect(connection: Parameters<Agent<Env>['onConnect']>[0], context: Parameters<Agent<Env>['onConnect']>[1]): Promise<void> {
    if (this.env.HOSTED_MODE === 'true') {
      const tokenHash = context.request.headers.get('x-lamplit-session-hash')
      if (!tokenHash || !/^[a-f0-9]{64}$/.test(tokenHash)) {
        connection.close(1008, 'Session required')
        return
      }
      connection.setState({ tokenHash })
    }
    await super.onConnect(connection, context)
  }

  async verifyCurrentConnection(): Promise<void> {
    if (this.env.HOSTED_MODE !== 'true') return
    const connection = getCurrentAgent().connection
    if (!connection) return
    await this.verifyConnection(connection)
  }

  async verifyConnection(connection: Parameters<Agent<Env>['onConnect']>[0]): Promise<void> {
    if (this.env.HOSTED_MODE !== 'true') return
    const tokenHash = (connection.state as HostedConnectionState | null)?.tokenHash
    const instanceId = this.name.split(':')[0]
    if (!tokenHash || !this.env.PLATFORM || !this.env.CHAT_INTERNAL_SECRET || !/^[0-9a-f-]{36}$/.test(instanceId)) throw new Error('Session is invalid')
    const response = await this.env.PLATFORM.fetch(`${this.env.PLATFORM_ORIGIN ?? 'https://app.lamplit.run'}/internal/chat-session/${tokenHash}/${instanceId}`, {
      headers: { 'x-lamplit-internal-secret': this.env.CHAT_INTERNAL_SECRET },
    })
    const result = response.ok ? await response.json() as { active: boolean } : { active: false }
    if (!result.active) {
      connection.close(1008, 'Session expired')
      throw new Error('Session expired')
    }
  }
}

export function hostedCallable(metadata: Parameters<typeof callable>[0] = {}) {
  return function <This extends HostedAgent, Args extends unknown[], Result>(
    method: (this: This, ...args: Args) => Promise<Result>,
    context: ClassMethodDecoratorContext<This, (this: This, ...args: Args) => Promise<Result>>,
  ) {
    const guarded = async function (this: This, ...args: Args): Promise<Result> {
      await this.verifyCurrentConnection()
      return method.apply(this, args)
    }
    return callable(metadata)(guarded, context as never)
  }
}
