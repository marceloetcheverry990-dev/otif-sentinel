// Upload base64 evidence to the Worker and return its public URL.
// The Worker only accepts evidence URLs from its own storage, so events
// must upload first and reference the returned URL.

import { API_BASE_URL as API_URL } from '../config/api';

export async function uploadEvidencePhoto(
  token: string,
  photoBase64: string
): Promise<string | null> {
  try {
    const response = await fetch(`${API_URL}/api/upload-evidence`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ photo: photoBase64 }),
    });
    const data = await response.json();
    if (response.ok && data.url) return data.url as string;
    console.warn('[uploadEvidencePhoto] rechazo del servidor:', data.error || response.status);
    return null;
  } catch (err) {
    console.warn('[uploadEvidencePhoto] error de red:', err);
    return null;
  }
}
