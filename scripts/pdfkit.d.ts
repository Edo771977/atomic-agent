/** PDFKit surface used by the disposable document-fixture generator. */
declare module "pdfkit" {
  import { Readable } from "node:stream";

  interface PDFDocumentOptions {
    autoFirstPage?: boolean;
  }

  class PDFDocument extends Readable {
    constructor(options?: PDFDocumentOptions);
    addPage(): this;
    fontSize(size: number): this;
    text(text: string): this;
    end(): void;
  }

  export default PDFDocument;
}
