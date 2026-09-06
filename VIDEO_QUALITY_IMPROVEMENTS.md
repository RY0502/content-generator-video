# Video Quality & Caption Behavior

> Current production contract. Earlier versions assembled series key art,
> episode key art, and generated scene PNGs. Those still-image branches and
> their image QA are retired; existing legacy files are not used for production
> assembly.

## Agnes scene normalization

Each production scene has exactly one canonical Groq narrator WAV of at most 12
seconds and exactly one Agnes text-to-video clip. After download, provider audio
is discarded and the clip is normalized to:

- 1920x1080 at 30 fps;
- H.264 (`libx264`) with preset `medium` and CRF 18;
- square pixels and `yuv420p` compatibility format;
- the measured duration of that scene's canonical WAV.

Scaling preserves the Agnes clip's aspect ratio and pads when needed. A scene is
not split into multiple video segments, and a normalized clip is consumed only
once.

## Final assembly

Assembly validates the complete persisted scene manifest before running. It
uses only canonical `agnes_text/scenes/scene_NNN.mp4` visuals and canonical
`audio/scene_NNN_narrator.wav` narration, in scene-number order. There are no
series/episode key-art introductions and no inter-scene transition padding.

The final narration track is built from the measured WAV durations, so video
timing follows the generated speech rather than an estimated character count.
Optional sound effects and background music retain the existing mixing rules.

## Captions

Caption timings begin at zero and remain contiguous across scene WAV durations.
By default, `burnSubtitles=false` creates clean video frames and YouTube can use
closed captions or automatic captions. If burn-in is explicitly enabled and a
caption file exists, ffmpeg renders the captions into the video; a burn-in
failure leaves a clean video and reports a warning.

The retired `mov_text` subtitle-track and mandatory key-art-audio behavior do
not describe the current production flow.
