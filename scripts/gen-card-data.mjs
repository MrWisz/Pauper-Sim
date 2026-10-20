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
    // double-faced cards (Delver of Secrets // Insectile Aberration) are keyed by their front face
    const name = c.card_faces ? face.name : c.name;
    out[name] = {
      name,
      manaCost: face.mana_cost ?? '',
      cmc: c.cmc,
      typeLine: face.type_line ?? c.type_line,
      oracle: face.oracle_text ?? '',
      colors: face.colors ?? c.colors ?? [],
      power: face.power,
      toughness: face.toughness,
      keywords: c.keywords ?? [],
      image: (face.image_uris ?? c.image_uris)?.normal,
      art: (face.image_uris ?? c.image_uris)?.art_crop,
    };
    const back = c.card_faces?.[1];
    if (back && c.layout === 'transform') {
      out[name].back = {
        name: back.name,
        manaCost: back.mana_cost ?? '',
        cmc: c.cmc,
        typeLine: back.type_line,
        oracle: back.oracle_text ?? '',
        colors: back.colors ?? [],
        power: back.power,
        toughness: back.toughness,
        keywords: [], // Scryfall merges both faces' keywords; per-face keywords come from scripts
        image: back.image_uris?.normal,
        art: back.image_uris?.art_crop,
      };
    }
  }
  await new Promise((r) => setTimeout(r, 150));
}
fs.writeFileSync('src/engine/cards/cardData.json', JSON.stringify(out, null, 1));
console.log('Wrote', Object.keys(out).length, 'cards');
