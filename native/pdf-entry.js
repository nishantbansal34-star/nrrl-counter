// Bundled into pdf.js: makes bill PDFs. Loaded only when a PDF is first shared, so the app starts faster.
import { jsPDF } from 'jspdf';
window.NrrlPdf = { jsPDF };
