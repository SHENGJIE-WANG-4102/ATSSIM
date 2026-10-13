# 02A05 牵引音

把 `traction.mp3`（起步）和 `brake.mp3`（电制动停车）放在这个目录下，选中列车时就会播放对应的牵引音。缺少文件时没有声音，不影响其他功能。

两段录音是第三方素材，不随仓库发布（`*.mp3` 已被 git 忽略）。可以用 `scripts/vvvf-clips.sh path/to/p02.wav` 从原始录音剪出来，剪切时间和 `src/data/vvvf.ts` 中的表对应。
