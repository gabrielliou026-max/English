# ALCPT 聽力・閱讀練習

手機用的 ALCPT 英文練習網頁（純靜態網站，可放在 GitHub Pages）。

- 每份 PDF 逐字稿為一個題庫（第 01 回、第 02 回…），可單選或多選題庫
- 依 ALCPT 題型順序出題、各題型內隨機：聽力 問答 → 敘述 → 對話，閱讀 文法／字彙 → 閱讀理解；可選全部／50／20 題（各題型依比例抽）
- 聽力題只播放語音（可重播），作答後顯示逐字稿、正解與解析
- 語音為預先以 Kokoro TTS 產生的 MP3（美式英文、正常語速）；對話題男聲（M）、女聲（W）、題目旁白（Q）各用不同聲音（第 01 回為 Gemini TTS）
- 考試紀錄、各題型答對率、最常答錯的題目、錯題複習；紀錄存在手機瀏覽器，可匯出／匯入備份

## 使用

以網站方式開啟 `index.html`（直接雙擊檔案無法載入題庫）：

```bash
python3 -m http.server 8000   # 然後開 http://<電腦IP>:8000
```

或在 GitHub 的 Settings → Pages 設定從此分支發佈。

## 新增題庫（共 31 回）

```bash
pip install -r tools/requirements.txt
python3 tools/parse_pdf.py 第03回.pdf        # 產生 data/bank03.json 並更新 data/banks.json
python3 tools/gen_audio.py data/bank03.json  # 產生 audio/b03/*.mp3（Kokoro，首次會下載模型到 tools/models/）
```

- 只重做某幾題：`--force --only 13,51`
- Kokoro 聲音：男 am_fenrir、女 af_heart、旁白 am_echo（試聽頁：`voices/`）
- 也可改用 Gemini：`GEMINI_API_KEY=… python3 tools/gen_audio.py data/bank03.json --engine gemini`（付費、每日有請求上限）
- 產生時會印出每題語速（words/s），異常的會標示 `check`，建議抽聽

回數會自動從 PDF 頁首「第 NN 回」讀取，讀不到時可加 `--bank 3`。

聲音設定在 `tools/gen_audio.py` 的 `VOICES`（Gemini：男 Puck、女 Kore、旁白 Charon）；Gemini 模型可用環境變數 `GEMINI_TTS_MODEL` 更換（預設 `gemini-3.8-flash-tts`）。

## 題型分類

| 分類 | 題號 | 判斷方式 |
|---|---|---|
| 聽力・問答 | 1–25 | 題幹為問句 |
| 聽力・敘述 | 26–50 | 題幹為直述句 |
| 聽力・對話 | 51–60 | 題幹含 M:/W: |
| 文法 | 61–95 | PDF 標註（文法） |
| 字彙 | 61–95 | 其餘短題 |
| 閱讀理解 | 96–100 | 長篇短文 |
