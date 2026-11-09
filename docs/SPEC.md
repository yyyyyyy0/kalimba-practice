# Kalimba Practice 仕様

8 音ミニカリンバの練習用 Web アプリ。マイクで弾いた音を拾い、発音の瞬間と音程が譜面のノーツと合えばヒットにするリズムゲームと、チューナーを持つ。依存ライブラリなし、ビルドなしの静的サイト（ES modules）。`python3 -m http.server` などで localhost から開く（AudioWorklet と getUserMedia は安全なコンテキストが必要で、file:// ではモジュールが読めない）。

UI の文言はすべて日本語。

## ファイル構成

```
index.html
css/style.css
js/songs.js          譜面データ（書き換えない。形式の問題があれば報告）
js/score.js          譜面文字列のパーサと検証（純粋関数）
js/tuning.js         音名・周波数・cent 計算、歯プリセット、周波数→歯のマッチ（純粋）
js/pitch.js          YIN 音高検出（純粋）
js/onset.js          発音検出（純粋、状態はクラス内）
js/chord.js          既知 8 周波数への当てはめで、新しく鳴り始めた歯の組を求める（純粋）
js/sinefit.js        周波数が既知の正弦波の最小二乗フィットと周波数の精密化（純粋）
js/analyzer.js       サンプル列 → PluckEvent / TunerReading を出す解析器（純粋、onset+pitch+chord を束ねる）
js/judge.js          判定の状態機械（純粋）
js/synth.js          カリンバ風の合成音を Float32Array で生成（純粋）。ブラウザでは AudioBuffer に詰める
js/audio.js          AudioContext、マイク、AudioWorklet、疑似マイク、メトロノーム
js/capture-worklet.js AudioWorkletProcessor。256 フレームずつ main に送る
js/game.js           ゲーム画面（Canvas 描画、進行、結果）
js/tuner.js          チューナー画面
js/settings.js       設定・キャリブレーション画面、localStorage（try/catch で包む）
js/main.js           画面切り替えと配線
test/*.test.mjs      node --test で実行
tools/check-songs.mjs 譜面の検証（範囲・小節の拍数）。失敗時は非 0 終了
README.md            日本語。起動方法、使い方、調律のしかた、判定の仕組み、制限
package.json         "type":"module"、scripts: test, check（依存なし）
```

## データの形

```js
// score.js
Song   = { id, title, credit, note?, kind: 'song'|'drill', level, bpm, beatsPerBar, score: string }
Note   = { index, degree: 1..8, beat: number, beats: number }   // 休符は Note にしない
parseScore(score: string) → { notes: Note[], bars: number[][] /* 各小節のトークン拍数 */ }
validateSong(song) → string[]  // エラー文の配列。空なら OK
//   ・度数が 0..8 の整数
//   ・最初と最後以外の小節の拍数合計 == beatsPerBar（最初はアウフタクト、最後は短くてよいが beatsPerBar を超えない）
//   ・ノーツが 1 個以上

// tuning.js
TinePreset = { id, label, freqs: number[8] }   // 低い順。index 0 = 度数 1
PRESETS: テーブル（registry）で持つ。'c4' (C4–C5), 'c5' (C5–C6)。A4 基準は引数（既定 440）
makePreset(id, a4) → TinePreset
calibratedPreset(freqs) → TinePreset    // 実測 8 本を昇順に並べたもの
freqToMidi, midiToFreq, centsBetween(f, ref), noteName(midi) → { ja: 'ド', en: 'C5', degreeLabel }
matchTine(freq, preset, { toleranceCents = 40, octaveFree = false })
  → { degree: 1..8, cents } | null
  // 最も近い歯を選び |cents| <= tolerance なら一致。
  // octaveFree のとき、直接一致しなければ freq を 2 倍・1/2 倍して再判定し、さらに度数 1 と 8 を同一視できるよう
  // pitchClassOf(degree) = ((degree-1) % 7) を judge 側で使う。
DEGREE_LABELS: ['1','2','3','4','5','6','7','1̇'] と SOLFEGE: ['ド','レ','ミ','ファ','ソ','ラ','シ','ド']
LAYOUTS: テーブル。'kalimba' = 左から [8,6,4,2,1,3,5,7]（中央が低音で左右交互、17 音カリンバと同じ規則からの推測）、
         'kalimba-mirror' = [7,5,3,1,2,4,6,8]、'scale' = [1..8]

// analyzer.js
PluckEvent   = { time /* AudioContext 秒。発音時刻 */, freq, clarity, degree|null, cents|null }
TunerReading = { time, freq|null, clarity, rmsDb }
class Analyzer {
  constructor({ sampleRate, getPreset, getMatchOpts, sensitivity })
  push(samples: Float32Array, startTime: number)  // 任意長。内部で hop=256 に切る
  onPluck(cb), onTuner(cb), onLevel(cb)  // または push の戻り値で返す。どちらでもよいが一貫させる
}

// judge.js
Judgement = 'perfect' | 'great' | 'good' | 'miss'
WINDOWS = { perfect: 0.045, great: 0.09, good: 0.15 }  // 秒、|dt| 以下
ChartNote = Note + { time /* 秒、ゲーム時刻 */, state: 'pending'|'hit'|'missed', judgement?, dt? }
createJudge({ notes: ChartNote[], mode: 'timed'|'wait', octaveFree, confirmDelay = 0.12 })
  .onPluck(event: { time, degree })  → { kind: 'hit', note, judgement, dt } | { kind: 'wrong', degree } | { kind: 'ignored' }
  .tick(now)  → missed notes[]   // now > note.time + WINDOWS.good + confirmDelay で miss
  .result()   → { counts, accuracy, maxCombo, combo, perDegree: { [d]: { hit, miss, wrong, meanDt } }, score }
// timed: 同じ度数で未判定のうち |dt| が最小（窓内）のノーツにだけ当てる。1 回の発音で 2 ノーツは叩けない。
// wait:  次の未判定ノーツで止まる。正しい度数が来たら 'great' 相当でヒット（dt は記録しない）。誤りは wrong。
// スコア: perfect 1000, great 700, good 400, miss 0。combo は miss と wrong で切れる。
```

## 音声処理

### 取り込み
- `getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, deviceId? } })`。
  ブラウザ既定の処理は伸びる音を消すので必ず切る。
- AudioWorklet で 256 フレームずつ main スレッドへ送る（`{ frame: currentFrame, data }`）。時刻は `frame / sampleRate`。
- マイク音はスピーカーに出さない。

### 音高検出（pitch.js, YIN, de Cheveigné & Kawahara 2002）
- `detectPitch(buf, sampleRate, { minFreq = 150, maxFreq = 2200, threshold = 0.12 }) → { freq, clarity } | null`
- 窓 2048（48kHz で約 43ms）。tau の範囲を minFreq..maxFreq に絞って計算量を抑える。
- 差分関数 → 累積平均正規化 → 閾値を最初に下回った tau の局所最小 → 放物線補間。clarity = 1 − d'(tau)。
- RMS が極小なら null。
- カリンバの歯は片持ち梁なので、上の倍音は基音の約 6.27 倍・17.55 倍で整数倍ではない。YIN はこの条件でオクターブを誤りにくい。

### 発音検出（onset.js）
- hop 256 ごとに 1 次差分 `x[n]-x[n-1]` のエネルギー（高域寄り。爪や指が歯を弾くクリックで立ち上がる）を dB で出す。
- 直前約 40ms の平均より `riseDb`（既定 9dB、設定の「感度」で 5〜15dB）以上上がり、かつ追従ノイズフロア + 12dB を超えたら発音。
- 不応期 70ms。減衰中の音では発音を出さない。同じ音の連打でも、新しい発音のクリックで検出できる。

### 解析器（analyzer.js）
- 発音を検出したら、発音時刻から 25〜95ms の間に終わる窓で YIN をかけ、clarity ≥ 0.8 の推定の中央値を確定周波数にする。推定が 2 個未満なら捨てる。
- 確定したら `matchTine` して PluckEvent を出す（時刻は発音時刻）。確定前に次の発音が来たら、その時点の推定で確定する。
- チューナー用に約 20ms ごとに TunerReading を出す（中央値で平滑化）。

### 遅延補正
- 設定に `latencyMs`（既定 0）。判定に渡す時刻は `event.time − latencyMs/1000`。
- 自動補正：BPM 90 でメトロノームを 8 回鳴らし、ユーザーは合わせてどれかの歯を弾く。各クリックに最も近い発音との差の中央値を latencyMs にする（4 個以上取れたときだけ）。

### 合成音（synth.js）
- `renderKalimba(freq, sampleRate, { duration = 2.5, velocity = 1 }) → Float32Array`
- 基音（減衰の時定数は高い音ほど短く、0.8〜2.5s）＋ 6.27 倍音（振幅 0.25、時定数 0.12s）＋ 17.55 倍音（0.08、0.04s。ナイキスト超えは省く）
  ＋ 最初の 3ms のクリック（ハイパスしたノイズ、振幅 0.3）。乱数はシード付き（テストを再現可能にする）。
- 用途：お手本再生、メトロノーム（クリックは音程のないノイズバースト）、疑似マイク。

### 疑似マイク（E2E と動作確認用）
- URL パラメータ `?sim=autoplay|wrong|silence`（任意で `&song=<id>&speed=<0.5..1.25>&mode=timed|wait`）。
- マイクの代わりに合成音を AudioWorklet の入力へつなぐ。autoplay は譜面どおりの時刻・度数、wrong は度数を +1（8 は 7）にずらす、silence は何も鳴らさない。
- 疑似マイク中は画面上部に「疑似マイク」と表示する。
- `window.__kalimba = { state: 'idle'|'countin'|'playing'|'result', result, events: PluckEvent[] }` を常に更新する（自動テストが読む）。

## ゲーム

- 曲選択：曲名、出典表記（credit）、編曲メモ（note）、難易度、ベストスコア。
- 設定：速度 50/75/100/125%、モード timed / wait（待ちモード：正しい音を弾くまで止まる）、スクロール速度。
- 開始前にカウントイン 1 小節（画面表示。メトロノーム音は設定でオン/オフ、既定オン）。メトロノームのクリック時刻 ±20ms の発音は無視する（スピーカーからの回り込み対策）。
- 描画は rAF、判定と miss 検出はオーディオ側の時刻で進める（worklet のメッセージごとに judge.tick）。タブが裏でも判定はずれない。
- レーン：LAYOUTS の並び。各レーンの上端ではなく判定ライン下に、度数（1〜7、1̇）とドレミと英音名。ノーツは上から落ちる。色は度数ごと（1 と 8 は同系色）。
- 判定ラインの下にカリンバの図（中央の歯が長く外側ほど短い）。検出した歯を光らせ、判定（PERFECT/GREAT/GOOD/MISS、ずれた音なら「ファ を弾いた」）を表示する。
- HUD：スコア、コンボ、進捗。Esc / ボタンで中断。
- 結果：判定ごとの数、精度、最大コンボ、苦手な歯（miss+wrong が多い順に上位 3）、歯ごとの平均ずれ（早い/遅い）。ベストスコアを localStorage に保存。
- お手本再生：判定なしで合成音を鳴らしながらノーツを流す。

## チューナー

- 大きな表示：音名（ドレミと C5 形式）、周波数 Hz、cent メーター（−50〜+50、±5 以内は緑）。
- 現在のプリセットで最も近い歯と、その歯へのずれ。
- 調律チェック表：8 本それぞれの最後に測った cent。±5 緑、±15 黄、それ以上は赤。
- 説明文：「振動する部分（ブリッジから手前の先端まで）を長くすると音が下がり、短くすると上がる。チューニングハンマーで少しずつ叩いて調整する」。
- 入力レベルメーター。マイク未許可・拒否時の案内。

## 設定・キャリブレーション

- 楽器：プリセット（C4–C5 / C5–C6 / 実測）、A4 基準（415〜466Hz、既定 440）、レーンの並び（LAYOUTS）。
- 判定：許容 cent（20〜50、既定 40）、オクターブ違いも正解にする、感度。
- キャリブレーション：「低い音から順に 8 本弾いてください」。1 本ずつ待ち、安定した周波数（clarity ≥ 0.9 の推定が 300ms 続く）を登録。
  昇順になっていない・隣り合う 2 本が 60 cent 未満なら、やり直しを促す。保存すると「実測」プリセットになる。
- 遅延補正（上記）。入力デバイスの選択（enumerateDevices）。

## テスト（node --test、合成音は synth.js を使う）

合格条件（変更しない）：
1. pitch：プリセット c4・c5 × A4=440/442 の 8 音すべてで、発音 50ms 後の窓の検出誤差が ±5 cent 以内、オクターブ誤り 0。
   SNR 20dB のホワイトノイズ下、別の歯の音が −12dB で鳴り続けている状態でも同じ。無音・ノイズだけでは null。
2. onset：打鍵列（同じ音の 300ms 間隔の連打、−6dB の弱い再打鍵、前の音が鳴っている中の打鍵を含む）で、
   検出数 = 打鍵数、各時刻 ±15ms 以内。無音・ノイズ・減衰中の単音で誤検出 0。
3. tuning：周波数計算、matchTine の境界（tolerance ちょうど内外）、octaveFree。
4. judge：各窓の境界、miss の時刻（confirmDelay 込み）、1 回の発音で 2 ノーツ叩けない、wrong、wait モード。
5. score：全曲 validateSong がエラー 0。
6. pipeline：曲を譜面どおりに合成した 1 本の音声（音は重なって減衰する）を Analyzer → judge に流すと、
   全曲で miss 0・wrong 0・perfect+great ≥ 95%。度数を 1 ずらした音声では hit 0。

## 和音（v2 で追加）

和音の譜面を増やし、難易度 4〜5 の曲を足した。単音前提だった検出・判定を、同時に弾いた複数の歯に対応させる。
既存の単音の曲・テスト・合格条件はそのまま守る（閾値を緩めない）。

### 譜面の記法（score.js）
- 和音は `[1 3 5]` または `[1 3 5]:2`。括弧内は空白区切りの度数（1..8、重複なし、2〜4 個）。拍数は和音全体に付く。
- Note に `chord: number | null` を足す。同じ括弧のノーツは同じ chord 番号（譜面内で 0 から連番）を持ち、beat も beats も同じ。単音は null。
- `playable(degrees, layoutOrder)` を score.js に置き、validateSong は既定レイアウト（LAYOUTS.kalimba の並び）で全和音を検査する。
  規則：並びの中の位置を昇順に並べ、連続した位置のまとまり（run）に分ける。
  run が 1 つなら長さ 4 以下で OK。run が 2 つなら、各 run の長さが 3 以下、左の run の最大位置 ≤ 4、右の run の最小位置 ≥ 3 で OK（左右の親指で 1 つずつ）。それ以外は NG。
- check-songs.mjs は和音の数と、押さえられない和音をエラーとして出す。
- level は 1〜5（星 5 つで表示）。曲一覧は kind（ドリル → 曲）、その中で level 昇順に並べる。

### 検出（analyzer.js）
歯の周波数は既知（preset.freqs、8 個）なので、多重ピッチ推定ではなく「既知 8 周波数への当てはめ」で、新しく鳴り始めた歯の組を求める。
- 発音を検出したら、発音直前の窓（今の残響推定と同じ RING_FIT 区間）と、発音後の窓（発音 + 25ms 〜 + 約 110ms に終わる窓。ストラムで後から鳴る歯も入るよう、和音用は今の 95ms より少し長くてよい）で、preset の 8 周波数の正弦波を最小二乗で同時に当てはめる（sinefit.js を使う）。
- 歯 k の「新しい発音」の判定：同じ歯を打ち直すと、指が歯に触れて前の振動は止まり、新しい振動に置き換わる（足し算にはならない）。
  そこで、発音後の窓へ当てはめた歯の係数 p と、発音前の残響を減衰込みで外挿した係数 r を比べ、鳴り続けているだけ（p ≈ r）か、打ち直された（p は r と無関係）かを決める。
  1. 振幅の比 |p|/|r| が 1/AMP_BAND〜AMP_BAND（±10%）の外なら打ち直し。
  2. 比が帯の中でも、|p − r|/|r| が PHASE_DIST（周波数が既知なら 0.2、未知なら 0.4）以上なら疑う。疑った歯は、周波数を自由にして当てはめ直し、過去に測った周波数から 15 cent 以内なら打ち直し、それ以上ずれていれば（周波数のずれで位相がずれただけなので）鳴り続けているだけとみなす。
  3. 基音の振幅と位相がたまたま残響と揃った打ち直し（約 0.1%）は、基音だけでは区別できない。打たれた歯は直後に 2 番目の振動モード（基音の 6.27 倍、約 0.1 秒で消える）が強いので、発音後の窓でその振幅が基音の ATTACK_REL（0.1）倍以上なら打ち直し。実機でこの比が合成音より小さい歯では 3 は働かず見逃しが残り、大きい歯（または 6.27 倍付近に箱の共鳴や雑音がある場合）では、鳴り続けているだけの歯を打ち直しと誤判定して wrong が増えうる。実機での比の採取が必要（未確認）。単音の見逃しは、YIN の推定が歯に一致すればその 1 本として渡す保険で補う。
  - 残響がない歯は新しく鳴った歯。どの場合も、新しく鳴った歯のうち最大のものから −20dB 以内の歯だけを組に入れる。閾値は定数にしてテストで決める。
- 各歯の周波数は、当てはめ振幅が最大になる周波数を ±60 cent の範囲で探して精密化し、cents を出す。許容 cent を超える歯は組に入れない（音の外れた歯や物音を拾わない）。
- 単音のときは、今の YIN 経路の結果（freq, clarity）も今までどおり出す。チューナーとキャリブレーションはこれを使う。YIN の窓から引く残響は、打ち直された歯を除く（置き換わった歯の前の振動は残っていない）。
- 発音から 60ms 以内に次の発音が来たら、同じ発音（ストラム）としてまとめる。

PluckEvent の形を変える：
```js
PluckEvent = {
  time,                 // 最初の発音時刻
  tines: [{ degree, freq, cents, level /* dB */ }],  // 新しく鳴り始めた歯。度数の昇順。許容外は含めない。空なら judge には渡さない
  freq, clarity,        // 主たる音（YIN）。チューナー・キャリブレーション用
  degree, cents,        // 主たる音の一致結果（今までと同じ意味）。互換のため残す
}
```

### 判定（judge.js）
- `onPluck({ time, degrees })` を受ける（degrees は tines の度数の配列）。戻り値は結果の配列（各度数について hit / wrong）。
- timed：度数ごとに、同じ度数で未判定・窓内・|dt| 最小のノーツに当てる。1 つの発音で同じ度数のノーツを 2 つは叩けないが、違う度数ならいくつでも当たる。どのノーツにも当たらない度数は wrong（1 発音で wrong は最大 1 回だけ数える）。
- wait：次の未判定ノーツが和音なら、その和音の全ノーツが当たるまで止まる。1 回の発音で一部だけ当たったら、残りは次の発音で当ててよい。和音に含まれない度数は wrong。
- result に `chords: { total, complete }`（全ノーツが hit した和音の数）を足す。

### 画面
- 和音のノーツは同じ高さで並び、レーンをまたぐ横棒でつなぐ（どの歯を同時に弾くかが一目でわかる）。
- 判定の表示は和音ごとに 1 つ（全部当たれば最も悪い判定、欠けたら「和音: 2/3」のように）。
- 結果画面に「和音 n / m 成功」を出す。
- 曲選択のメタ情報に「和音あり」を出す。

### 疑似マイク
- 同じ歯を打ち直すと、前の音を 4ms で絞って止める（足し算で重ねない）。テストの合成音（test/helpers.mjs の renderStrikes）も同じ。
- 和音は歯ごとに 0〜25ms のずらし（シード付き乱数）と ±3dB の強さの揺れを付けて鳴らす（人がストラムしたときの近似）。`&strum=<ms>` で最大ずらしを変えられる。

### テスト（追加。合格条件は変更しない）
7. chord：譜面に出てくる全和音（重複除く）× preset c4・c5 × 48kHz で、ストラムのずらし 0ms・15ms はシード 20 通りで検出した歯の組が 100% 完全一致（欠けも余分もなし）、30ms は 95% 以上完全一致。
8. chord subset：3 音の和音のうち 2 音だけ鳴らすと、その 2 音だけが検出される（20 通りで 100%）。
9. 単音の誤検出：既存の全単音曲で tines が常に 1 個（余分な歯が出ない）。
10. pipeline：全曲（和音の曲を含む）を c4/48k・c5/44.1k・c4/192k、ストラムのずらし最大 25ms で流すと miss 0・wrong 0・perfect+great ≥ 95%。度数を 1 ずらした音声（8 は 7）では hit 0。
11. judge：和音の部分ヒット、同じ発音での複数度数ヒット、wait モードで和音が揃うまで止まること、chords 集計。
12. score：括弧の構文エラー（閉じ忘れ、空、重複、範囲外）、chord 番号、playable の境界。
13. robustness（頑健性の掃引）：和音の曲と repeat・fast-scale を、乱数の種 × 開始位置のずれ（lead に 0〜10ms）を振って c4/48k（5 通り）と c4/192k（3 通り）で流し、miss 0・wrong 0。打ち直しは置き換えの物理で鳴らす。
