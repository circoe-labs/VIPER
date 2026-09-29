import { scheduleStateBackup } from './stateCache';

export async function previewWorkbook(file: File) {
  const fd = new FormData();
  fd.append('file', file, file.name);
  const response = await fetch('/api/import/preview', { method: 'POST', body: fd });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || 'Import impossible');
  return body;
}

export async function commitWorkbookPreview(preview: any) {
  const response = await fetch('/api/import/commit', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(preview)
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || 'Import impossible');
  scheduleStateBackup();
  return body;
}
