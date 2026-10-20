// Bundled into native.js for the Android app only: gives the page Google ML Kit barcode scanning.
import { Capacitor } from '@capacitor/core';
import { BarcodeScanner } from '@capacitor-mlkit/barcode-scanning';
window.NrrlNative = { native: Capacitor.isNativePlatform(), BarcodeScanner };
