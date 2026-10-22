// Bundled into native.js for the Android app only: fast barcode scanning (Google ML Kit),
// and making a bill PDF and sharing it (WhatsApp etc.).
import { Capacitor } from '@capacitor/core';
import { BarcodeScanner } from '@capacitor-mlkit/barcode-scanning';
import { Filesystem, Directory } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';
import { jsPDF } from 'jspdf';
window.NrrlNative = { native: Capacitor.isNativePlatform(), BarcodeScanner, Filesystem, Directory, Share, jsPDF };
