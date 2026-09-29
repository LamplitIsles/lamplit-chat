import type { CompanionImageDraft } from './client/image-drafts';
import type { PhotoUpload } from '../../../../src/shared/pi-contract';

async function base64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  return btoa(binary);
}

async function jpegVariant(file: File, maxSide: number, maxBytes: number): Promise<string> {
  const image = await createImageBitmap(file);
  try {
    let side = maxSide;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const scale = Math.min(1, side / Math.max(image.width, image.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(image.width * scale));
      canvas.height = Math.max(1, Math.round(image.height * scale));
      const context = canvas.getContext('2d');
      if (!context) throw new Error('Photo processing is unavailable.');
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.76));
      if (blob && blob.size <= maxBytes) return base64(blob);
      side = Math.round(side * 0.7);
    }
    throw new Error('Photo cannot fit the message size limit.');
  } finally {
    image.close();
  }
}

export async function preparePhotoUploads(operationId: string, drafts: readonly CompanionImageDraft[]): Promise<PhotoUpload[]> {
  if (drafts.length > 6) throw new Error('Choose up to six photos.');
  return Promise.all(drafts.map(async (draft, order) => {
    if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(draft.file.type)) throw new Error('Unsupported photo type.');
    if (draft.file.size > 8_000_000) throw new Error('Photo exceeds the 8 MB limit.');
    return {
      operationId, id: draft.id, order, name: draft.file.name || `photo-${order + 1}`, mediaType: draft.file.type,
      original: await base64(draft.file),
      preview: await jpegVariant(draft.file, 480, 160_000),
      model: await jpegVariant(draft.file, 1200, 320_000),
    };
  }));
}
