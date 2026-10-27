// Email verifikasi dan reset kata sandi (F-APP-1). Bila SMTP_URL kosong, email tidak dikirim dan
// isinya (termasuk tautan) dicetak ke log server. Cukup untuk uji di laptop; untuk dipakai orang lain,
// isi SMTP_URL, mis. smtps://user:sandi-aplikasi@smtp.gmail.com:465
import { cfg } from './config.js';

let transport = null;
if (cfg.smtpUrl) {
  const nodemailer = (await import('nodemailer')).default;
  transport = nodemailer.createTransport(cfg.smtpUrl);
}

export const mailConfigured = () => !!transport;
export const sentLog = []; // dibaca uji

export async function sendMail(to, subject, text) {
  sentLog.push({ to, subject, text });
  if (sentLog.length > 50) sentLog.shift();
  if (!transport) {
    console.log(`[email] SMTP_URL kosong, email tidak dikirim.\n  ke: ${to}\n  subjek: ${subject}\n  ${text.replace(/\n/g, '\n  ')}`);
    return false;
  }
  await transport.sendMail({ from: cfg.mailFrom, to, subject, text });
  return true;
}

const base = () => cfg.publicUrl || `http://localhost:${process.env.WEB_PORT || 8252}`;

export const verifyMail = (u, token) =>
  sendMail(u.email, 'Verifikasi email akun CardioVest',
    `Halo ${u.name},\n\nKetuk tautan berikut untuk memverifikasi email akun CardioVest Anda:\n${base()}/verifikasi/${token}\n\nTautan berlaku 24 jam. Abaikan email ini bila Anda tidak mendaftar.`);

export const resetMail = (u, token) =>
  sendMail(u.email, 'Atur ulang kata sandi CardioVest',
    `Halo ${u.name},\n\nAda permintaan atur ulang kata sandi akun CardioVest Anda. Ketuk tautan ini untuk membuat kata sandi baru:\n${base()}/atur-sandi/${token}\n\nTautan berlaku 1 jam. Bila Anda tidak memintanya, abaikan saja; kata sandi lama tetap berlaku.`);
