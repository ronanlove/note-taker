// Renders public/icon.svg into the PNG icons iOS and the web app manifest need. Run: npm run icons
import sharp from 'sharp';

const sizes = { 'apple-touch-icon.png': 180, 'pwa-192.png': 192, 'pwa-512.png': 512 };
for (const [file, size] of Object.entries(sizes)) {
  await sharp('public/icon.svg', { density: 300 }).resize(size, size).png().toFile(`public/${file}`);
  console.log(`public/${file}`);
}
