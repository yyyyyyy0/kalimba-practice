// Node 22 では `node --test test/` のディレクトリ指定をモジュールとして解決するため、この入口から全テストを読み込む。
import './pitch.test.mjs';
import './chord.test.mjs';
import './onset.test.mjs';
import './tuning.test.mjs';
import './judge.test.mjs';
import './score.test.mjs';
import './calibrate.test.mjs';
import './settings.test.mjs';
import './pipeline.test.mjs';
import './robustness.test.mjs';
