import AppKit
import Foundation

let outPath = CommandLine.arguments.dropFirst().first ?? "DomainScout-1024.png"
let size = NSSize(width: 1024, height: 1024)
let image = NSImage(size: size)

func color(_ hex: UInt32, _ alpha: CGFloat = 1.0) -> NSColor {
  let r = CGFloat((hex >> 16) & 0xff) / 255.0
  let g = CGFloat((hex >> 8) & 0xff) / 255.0
  let b = CGFloat(hex & 0xff) / 255.0
  return NSColor(calibratedRed: r, green: g, blue: b, alpha: alpha)
}

image.lockFocus()

let rect = NSRect(origin: .zero, size: size)
let bg = NSBezierPath(roundedRect: rect.insetBy(dx: 36, dy: 36), xRadius: 210, yRadius: 210)
color(0x101318).setFill()
bg.fill()

let inner = NSBezierPath(roundedRect: rect.insetBy(dx: 86, dy: 86), xRadius: 150, yRadius: 150)
color(0x171c22).setFill()
inner.fill()

NSGraphicsContext.current?.shouldAntialias = true

color(0x6b7280, 0.22).setStroke()
for i in stride(from: 210, through: 810, by: 120) {
  let v = NSBezierPath()
  v.move(to: NSPoint(x: i, y: 160))
  v.line(to: NSPoint(x: i, y: 865))
  v.lineWidth = 8
  v.stroke()

  let h = NSBezierPath()
  h.move(to: NSPoint(x: 160, y: i))
  h.line(to: NSPoint(x: 865, y: i))
  h.lineWidth = 8
  h.stroke()
}

let ring = NSBezierPath(ovalIn: NSRect(x: 220, y: 270, width: 510, height: 510))
color(0xd7ff4f).setStroke()
ring.lineWidth = 52
ring.stroke()

let handle = NSBezierPath()
handle.move(to: NSPoint(x: 650, y: 325))
handle.line(to: NSPoint(x: 835, y: 140))
handle.lineCapStyle = .round
handle.lineWidth = 70
color(0xd7ff4f).setStroke()
handle.stroke()

let dot = NSBezierPath(ovalIn: NSRect(x: 456, y: 506, width: 80, height: 80))
color(0x4fb8ff).setFill()
dot.fill()

let attrs: [NSAttributedString.Key: Any] = [
  .font: NSFont.monospacedSystemFont(ofSize: 190, weight: .heavy),
  .foregroundColor: color(0xf3f7f0),
  .kern: -12
]
let text = "ds" as NSString
let textSize = text.size(withAttributes: attrs)
text.draw(
  at: NSPoint(x: (1024 - textSize.width) / 2 - 5, y: 405),
  withAttributes: attrs
)

image.unlockFocus()

guard
  let tiff = image.tiffRepresentation,
  let rep = NSBitmapImageRep(data: tiff),
  let png = rep.representation(using: .png, properties: [:])
else {
  fatalError("Could not render icon")
}

try png.write(to: URL(fileURLWithPath: outPath))
