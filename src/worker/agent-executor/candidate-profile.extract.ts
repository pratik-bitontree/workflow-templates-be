/**
 * Resume text and email extraction for Candidate Profile Analyzer.
 * Ported from GrowStackAI-Backend-AI-Agent (extractContentAndImagesFromFile, extractEmailFromText).
 */

const EMAIL_REGEX = /\b[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}\b/gi;

export function extractEmailFromText(text: string): string | null {
  if (!text || typeof text !== 'string') return null;
  const matches = text.match(EMAIL_REGEX);
  return matches ? matches[0].toLowerCase() : null;
}

/**
 * Convert Google Drive "open" or "view" URLs to a direct-download URL.
 * Direct fetch of drive.google.com/open?id=... returns 404; use uc?export=download&id=...
 */
function toDirectDownloadUrl(url: string): string {
  const u = url.trim();
  // drive.google.com/open?id=FILE_ID
  const openMatch = u.match(/drive\.google\.com\/open\?id=([a-zA-Z0-9_-]+)/i);
  if (openMatch) return `https://drive.google.com/uc?export=download&id=${openMatch[1]}`;
  // drive.google.com/file/d/FILE_ID/view or /file/d/FILE_ID
  const fileMatch = u.match(/drive\.google\.com\/file\/d\/([a-zA-Z0-9_-]+)/i);
  if (fileMatch) return `https://drive.google.com/uc?export=download&id=${fileMatch[1]}`;
  // already uc?id= or uc?export=download&id=
  if (/drive\.google\.com\/uc\?/i.test(u)) return u;
  return u;
}

/**
 * Download file from URL and return buffer.
 * Converts Google Drive links to direct-download form so fetch gets the file instead of 404.
 */
async function downloadToBuffer(url: string): Promise<Buffer> {
  const downloadUrl = toDirectDownloadUrl(url);
  const res = await fetch(downloadUrl, { redirect: 'follow' });
  if (!res.ok) {
    const hint =
      /drive\.google\.com/i.test(url)
        ? ' (Google Drive link: ensure the file is shared so that "Anyone with the link" can view, or use a direct file URL)'
        : '';
    throw new Error(`Failed to download: ${res.status} ${res.statusText}${hint}`);
  }
  const ab = await res.arrayBuffer();
  return Buffer.from(ab);
}

/**
 * Extract plain text from a resume file (PDF or DOCX) URL.
 * Returns { resumeText, candidateEmail }.
 */
export async function extractResumeTextFromUrl(candidateProfileUrl: string): Promise<{
  resumeText: string;
  candidateEmail: string | null;
}> {
  if (!candidateProfileUrl || typeof candidateProfileUrl !== 'string') {
    throw new Error('candidateProfileUrl must be a non-empty string');
  }
  const url = candidateProfileUrl.trim();
  const buffer = await downloadToBuffer(url);

  let text = '';
  const lower = url.toLowerCase();
  const isPdf = lower.endsWith('.pdf') || (await inferPdfFromBuffer(buffer));
  const isDocx =
    lower.endsWith('.docx') ||
    lower.includes('wordprocessingml') ||
    (buffer[0] === 0x50 && buffer[1] === 0x4b); // ZIP magic for DOCX

  if (isPdf) {
    text = await extractTextFromPdf(buffer);
  } else if (isDocx) {
    text = await extractTextFromDocx(buffer);
  } else {
    // Default try PDF then DOCX
    try {
      text = await extractTextFromPdf(buffer);
    } catch {
      text = await extractTextFromDocx(buffer);
    }
  }

  const resumeText = (text || '').trim() || '(No text extracted from document)';
  const candidateEmail = extractEmailFromText(resumeText);
  return { resumeText, candidateEmail };
}

async function inferPdfFromBuffer(buffer: Buffer): Promise<boolean> {
  return buffer.length >= 5 && buffer[0] === 0x25 && buffer[1] === 0x50 && buffer[2] === 0x44 && buffer[3] === 0x46;
}

async function extractTextFromPdf(buffer: Buffer): Promise<string> {
  // pdfjs-dist in Node: dynamic import for ESM/legacy build
  const pdfjsLib = await import('pdfjs-dist').then((m: any) => m.default ?? m);
  const uint8Array = new Uint8Array(buffer);
  const loadingTask = pdfjsLib.getDocument({ data: uint8Array });
  const pdf = await loadingTask.promise;
  let fullText = '';
  for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
    const page = await pdf.getPage(pageNum);
    const content = await page.getTextContent();
    const pageText = content.items.map((item: any) => item.str).join(' ');
    fullText += pageText + '\n';
  }
  return fullText.trim();
}

async function extractTextFromDocx(buffer: Buffer): Promise<string> {
  const mammoth = await import('mammoth').then((m: any) => m.default ?? m);
  const result = await mammoth.extractRawText({ buffer });
  return (result.value || '').trim();
}
