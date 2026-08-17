# 3color · Triple-Plate Camera

A PWA camera that recreates the three-color photography method of Sergei Prokudin-Gorskii: capture the same scene through red, green, and blue channels, then combine them pixel by pixel into a full-color photo with an early-20th-century look.

[中文版](./README.zh-CN.md)

## Historical Background

From 1909 to 1915, Russian photographer **Sergei Mikhailovich Prokudin-Gorskii**, sponsored by Tsar Nicholas II, traveled across the Russian Empire with a modified camera. He exposed each scene three times on glass plates — once through each of **red, green, and blue filters** — then replayed them through three color projectors, producing some of the world's earliest color photographs. His surviving plates are now preserved in the Library of Congress.

## How It Works

1. Shoot three photos from the same position and composition (the interval is up to you)
2. Extract one channel from each frame as grayscale: red plate → R, green plate → G, blue plate → B
3. Merge pixel by pixel: `final.RGB = (redPlate.R, greenPlate.G, bluePlate.B)`
4. Moving subjects get natural color fringes from the time offset between plates — a signature of that era's photography

## Features

- **PWA**: installable, works offline
- **Auto / Manual** shooting modes: auto captures all three channels at the set interval; manual captures one channel per shutter press
- **Interval slider**: 0–8 s, adjustable, live value shown on the thumb
- **Vintage filter**: sepia tone, lifted blacks, desaturation, vignette, and grain — toggle to compare with the original composite
- **Photo history**: IndexedDB local gallery, with view / share / save-to-album

## Try It Online

<https://sealpp.github.io/3color/>

Open in a mobile browser → allow camera access → press the shutter. Rear camera and good lighting recommended.

---
Developed by [sealpp](https://github.com/sealpp)
