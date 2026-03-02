import { removeBackground } from '@imgly/background-removal';
import fs from 'fs';
import { Buffer } from 'buffer';

const url = 'https://images.unsplash.com/photo-1544005313-94ddf0286df2?w=400&q=80';

async function main() {
    console.log('Downloading and isolating image...');
    const blob = await removeBackground(url);
    const arrayBuffer = await blob.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    fs.writeFileSync('public/demo-after.png', buffer);
    console.log('Saved demo-after.png');

    const res = await fetch(url);
    const origBuffer = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync('public/demo-before.jpg', origBuffer);
    console.log('Saved demo-before.jpg');
}

main().catch(console.error);
