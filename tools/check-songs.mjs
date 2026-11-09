// 譜面の検証 (度数の範囲、小節の拍数)。エラーがあれば非 0 で終了する。
import { SONGS } from '../js/songs.js';
import { parseScore, validateSong } from '../js/score.js';

const errors = [];
const seen = new Set();
for (const song of SONGS) {
  if (seen.has(song.id)) errors.push(`[${song.id}] id が重複しています`);
  seen.add(song.id);
  errors.push(...validateSong(song));
}

for (const song of SONGS) {
  const { notes, bars } = parseScore(song.score);
  const beats = notes.length ? notes[notes.length - 1].beat + notes[notes.length - 1].beats : 0;
  const mark = errors.some((e) => e.startsWith(`[${song.id}]`)) ? 'NG' : 'OK';
  console.log(`${mark}  ${song.id.padEnd(9)} ノーツ ${String(notes.length).padStart(3)}  小節 ${String(bars.length).padStart(2)}  ${beats} 拍`);
}

if (errors.length > 0) {
  console.error(`\n${errors.length} 件のエラー`);
  for (const e of errors) console.error(`  ${e}`);
  process.exit(1);
}
console.log(`\n${SONGS.length} 曲、エラーなし`);
