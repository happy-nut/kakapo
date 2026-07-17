#!/usr/bin/env swift

import AppKit
import Foundation

guard CommandLine.arguments.count == 4 || CommandLine.arguments.count == 5 else {
  fputs("usage: round-icon.swift <input.png> <output.png> <corner-radius-fraction> [artwork-scale]\n", stderr)
  exit(2)
}

let input = CommandLine.arguments[1]
let output = CommandLine.arguments[2]
guard let radiusFraction = Double(CommandLine.arguments[3]), radiusFraction > 0, radiusFraction < 0.5 else {
  fputs("corner radius fraction must be between 0 and 0.5\n", stderr)
  exit(2)
}
let artworkScale = CommandLine.arguments.count == 5 ? Double(CommandLine.arguments[4]) : 1
guard let artworkScale, artworkScale > 0, artworkScale <= 1 else {
  fputs("artwork scale must be between 0 and 1\n", stderr)
  exit(2)
}
guard
  let data = FileManager.default.contents(atPath: input),
  let sourceRep = NSBitmapImageRep(data: data),
  let sourceImage = NSImage(data: data)
else {
  fputs("could not load input PNG\n", stderr)
  exit(1)
}

// Find the visible squircle rather than assuming a fixed transparent margin. A small alpha threshold
// ignores the faint outer shadow, keeping the mask pinned to the charcoal tile itself.
let width = sourceRep.pixelsWide
let height = sourceRep.pixelsHigh
var minX = width
var minY = height
var maxX = -1
var maxY = -1
let stride = 2
for y in Swift.stride(from: 0, to: height, by: stride) {
  for x in Swift.stride(from: 0, to: width, by: stride) {
    guard let color = sourceRep.colorAt(x: x, y: y), color.alphaComponent >= 0.08 else { continue }
    minX = min(minX, x)
    minY = min(minY, y)
    maxX = max(maxX, x)
    maxY = max(maxY, y)
  }
}
guard maxX >= minX, maxY >= minY else {
  fputs("input PNG has no visible icon tile\n", stderr)
  exit(1)
}

let tile = NSRect(
  x: CGFloat(max(0, minX - stride)),
  y: CGFloat(max(0, minY - stride)),
  width: CGFloat(min(width - 1, maxX + stride) - max(0, minX - stride) + 1),
  height: CGFloat(min(height - 1, maxY + stride) - max(0, minY - stride) + 1)
)
let canvas = NSRect(x: 0, y: 0, width: width, height: height)
let drawRect = NSRect(
  x: canvas.midX - canvas.width * artworkScale / 2,
  y: canvas.midY - canvas.height * artworkScale / 2,
  width: canvas.width * artworkScale,
  height: canvas.height * artworkScale
)
let scaledTile = NSRect(
  x: canvas.midX + (tile.minX - canvas.midX) * artworkScale,
  y: canvas.midY + (tile.minY - canvas.midY) * artworkScale,
  width: tile.width * artworkScale,
  height: tile.height * artworkScale
)
let radius = min(scaledTile.width, scaledTile.height) * radiusFraction
guard let targetRep = NSBitmapImageRep(
  bitmapDataPlanes: nil,
  pixelsWide: width,
  pixelsHigh: height,
  bitsPerSample: 8,
  samplesPerPixel: 4,
  hasAlpha: true,
  isPlanar: false,
  colorSpaceName: .deviceRGB,
  bytesPerRow: 0,
  bitsPerPixel: 0
) else {
  fputs("could not allocate output bitmap\n", stderr)
  exit(1)
}

NSGraphicsContext.saveGraphicsState()
guard let context = NSGraphicsContext(bitmapImageRep: targetRep) else {
  fputs("could not create output graphics context\n", stderr)
  exit(1)
}
NSGraphicsContext.current = context
context.imageInterpolation = .high
context.shouldAntialias = true
NSColor.clear.setFill()
NSRect(x: 0, y: 0, width: width, height: height).fill()
NSBezierPath(roundedRect: scaledTile, xRadius: radius, yRadius: radius).addClip()
sourceImage.draw(
  in: drawRect,
  from: .zero,
  operation: .sourceOver,
  fraction: 1,
  respectFlipped: true,
  hints: [.interpolation: NSImageInterpolation.high]
)
context.flushGraphics()
NSGraphicsContext.restoreGraphicsState()

guard let png = targetRep.representation(using: .png, properties: [:]) else {
  fputs("could not encode output PNG\n", stderr)
  exit(1)
}
try png.write(to: URL(fileURLWithPath: output), options: .atomic)
