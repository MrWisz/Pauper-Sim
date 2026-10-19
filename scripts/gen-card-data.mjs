// Fetches Oracle data + image URLs from Scryfall for every name in data/names.txt
// and writes src/engine/cards/cardData.json. Run: npm run gen-cards
import fs from 'node:fs';

const names = fs.readFileSync('data/names.txt', 'utf8').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
const out = {};
for (let i = 0; i < names.length; i += 70) {
  const res = await fetch('https://api.scryfall.com/cards/collection', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': 'PauperSim/0.1' },
    body: JSON.stringify({ identifiers: names.slice(i, i + 70).map((name) => ({ name })) }),
  });
  const json = await res.json();
  if (json.not_found?.length) console.warn('Not found:', json.not_found);
  for (const c of json.data) {
    const face = c.card_faces ? c.card_faces[0] : c;
    out[c.name] = {
      name: c.name,
      manaCost: face.mana_cost ?? '',
      cmc: c.cmc,
      typeLine: face.type_line ?? c.type_line,
      oracle: face.oracle_text ?? '',
      colors: c.colors ?? face.colors ?? [],
      power: face.power,
      toughness: face.toughness,
      keywords: c.keywords ?? [],
      image: (c.image_uris ?? face.image_uris)?.normal,
      art: (c.image_uris ?? face.image_uris)?.art_crop,
    };
  }
  await new Promise((r) => setTimeout(r, 150));
}
fs.writeFileSync('src/engine/cards/cardData.json', JSON.stringify(out, null, 1));
console.log('Wrote', Object.keys(out).length, 'cards');
