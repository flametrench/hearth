import { v7 as uuidv7 } from 'uuid';

export type HearthPrefix = 'inst' | 'ticket' | 'comment';

export function generateHearthId(prefix: HearthPrefix): string {
  const uuid = uuidv7();
  return `${prefix}_${uuid.replaceAll('-', '')}`;
}

export function uuidFromHearthId(id: string): string {
  const sep = id.indexOf('_');
  if (sep === -1) throw new Error(`Malformed Hearth id: ${id}`);
  const hex = id.slice(sep + 1);
  if (hex.length !== 32 || !/^[0-9a-f]{32}$/.test(hex)) {
    throw new Error(`Malformed Hearth id payload: ${id}`);
  }
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
