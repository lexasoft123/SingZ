# iPad store screenshots

`01-player.png` and `02-training.png` are real captures of SingZ 0.26.5 on an isolated 13-inch iPad simulator. Both are 2064×2752 RGB PNGs without alpha. The player comes first and shows highlighted lyrics from the app’s own bundled sample. Training was muted.

Uploaded to the English primary listing for 0.26.5 using `APP_IPAD_PRO_3GEN_129`, the API display type for the required 13-inch iPad set. Existing iPhone screenshots remain separate.

To replace only this device set across listing locales:

```bash
scripts/with-apple-secrets.sh ruby scripts/push-ios-screenshots.rb docs/ios-assets/ipad APP_IPAD_PRO_3GEN_129
```
