import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

export interface ConvertTextToPdfOptions {
  textInput: string | null | undefined;
  outputFileName?: string;
  workflowExecutionId?: string;
  nodeExecutionId?: string;
  deletePdf?: boolean;
}

/**
 * StandardFonts in pdf-lib use WinAnsi (Windows-1252) and cannot encode Unicode (e.g. Greek α).
 * Replace any character outside the WinAnsi range with '?' to avoid "WinAnsi cannot encode" errors.
 */
function toWinAnsiSafe(text: string): string {
  return [...text].map((c) => {
    const code = c.charCodeAt(0);
    return code >= 32 && code <= 126 ? c : '?';
  }).join('');
}

/**
 * Minimal tools service for workflow actions.
 * convertTextToPdf uses pdf-lib (no Puppeteer); outputs to temp dir and returns file path.
 */
@Injectable()
export class ToolsService {
  private readonly logger = new Logger(ToolsService.name);
  private readonly pdfDir: string;

  constructor() {
    this.pdfDir = path.join(os.tmpdir(), 'templates-workflow-pdfs');
  }

  async convertTextToPdf(dto: ConvertTextToPdfOptions): Promise<string> {
    if (!dto.textInput || typeof dto.textInput !== 'string') {
      throw new BadRequestException('Input text is required and must be a string');
    }

    await fs.mkdir(this.pdfDir, { recursive: true });

    const filename = dto.outputFileName || `pdf-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const outputPath = path.join(this.pdfDir, `${filename}.pdf`);

    const pdfDoc = await PDFDocument.create();
    const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const page = pdfDoc.addPage([595, 842]); // A4
    const { height } = page.getSize();
    const margin = 50;
    const lineHeight = 14;
    let y = height - margin;

    const lines = dto.textInput.split(/\r?\n/);
    const maxWidth = 495;

    for (const line of lines) {
      if (y < margin) {
        const newPage = pdfDoc.addPage([595, 842]);
        y = newPage.getSize().height - margin;
      }
      const words = line.split(/\s+/).filter(Boolean);
      let currentLine = '';
      for (const word of words) {
        const testLine = currentLine ? `${currentLine} ${word}` : word;
        const safeTestLine = toWinAnsiSafe(testLine);
        const textWidth = font.widthOfTextAtSize(safeTestLine, 11);
        if (textWidth > maxWidth && currentLine) {
          const pageRef = pdfDoc.getPages().length - 1;
          const p = pdfDoc.getPage(pageRef);
          p.drawText(toWinAnsiSafe(currentLine), { x: margin, y, size: 11, font, color: rgb(0, 0, 0) });
          y -= lineHeight;
          currentLine = word;
          if (y < margin) {
            pdfDoc.addPage([595, 842]);
            y = pdfDoc.getPage(pdfDoc.getPages().length - 1).getSize().height - margin;
          }
        } else {
          currentLine = testLine;
        }
      }
      if (currentLine) {
        const pageRef = pdfDoc.getPages().length - 1;
        const p = pdfDoc.getPage(pageRef);
        p.drawText(toWinAnsiSafe(currentLine), { x: margin, y, size: 11, font, color: rgb(0, 0, 0) });
        y -= lineHeight;
      }
    }

    const pdfBytes = await pdfDoc.save();
    await fs.writeFile(outputPath, pdfBytes);
    return outputPath;
  }
}
