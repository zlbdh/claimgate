export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

export function imageExtension(file) {
  const match = file.toLowerCase().match(/\.(png|jpe?g)$/);
  return match ? `.${match[1]}` : undefined;
}

export function hasImageMagic(bytes, extension) {
  const png = bytes.length >= 8 && Buffer.from(bytes.subarray(0, 8))
    .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const jpeg = bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
    && bytes[bytes.length - 2] === 0xff && bytes[bytes.length - 1] === 0xd9;
  return extension === ".png" ? png : ([".jpg", ".jpeg"].includes(extension) && jpeg);
}

export function approvedRepositoryImage(relative) {
  return /^(?:public|docs\/submission\/screenshots)\/[A-Za-z0-9._/-]+\.(?:png|jpe?g)$/i.test(relative);
}
