import { promises as fs } from 'fs';
import path from 'path';
import { uploadBuffer as cloudinaryUpload, deleteAsset as cloudinaryDelete } from './cloudinary.js';

const STORAGE_MODE = process.env.STORAGE_MODE ?? 'local';
const UPLOADS_DIR = path.resolve(process.cwd(), 'uploads');

export async function uploadFile(
  buffer: Buffer,
  folder = 'color-hunt',
): Promise<{ url: string; key: string }> {
  if (STORAGE_MODE === 'cloudinary') {
    const { url, publicId } = await cloudinaryUpload(buffer, folder);
    return { url, key: publicId };
  }

  const dir = path.join(UPLOADS_DIR, folder);
  await fs.mkdir(dir, { recursive: true });
  const filename = `${Date.now()}-${Math.random().toString(36).slice(2)}.jpg`;
  const filepath = path.join(dir, filename);
  await fs.writeFile(filepath, buffer);
  const key = path.join(folder, filename);
  return { url: `/uploads/${key}`, key };
}

export async function deleteFile(key: string): Promise<void> {
  if (STORAGE_MODE === 'cloudinary') {
    await cloudinaryDelete(key);
    return;
  }
  try {
    await fs.unlink(path.join(UPLOADS_DIR, key));
  } catch {
    // file already gone — ignore
  }
}
