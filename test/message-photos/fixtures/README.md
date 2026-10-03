Synthetic fixtures for the A6-PHOTOS metadata sanitizer
(test/message-photos/image-metadata.spec.ts). Generated with Pillow and
exiftool; every value is fake (camera "FixtureCam", coordinates 12.3456 N,
65.4321 W in open ocean, serial FIXTURE-SERIAL-001). No real person, place
or device.

- gps-orientation6.jpg: EXIF (Make, Model, serial, Orientation=6, full GPS
  block, IFD1 thumbnail), XMP (creator + GPS), IPTC keywords, JPEG comment.
- gps-mpf-trailer.jpg: the same file with a second copy appended after the
  end-of-image marker (how multi-picture / depth trailers ride along).
- gps.png: eXIf chunk with GPS, tEXt location text, iTXt XMP.
- gps.webp: VP8X with EXIF + XMP chunks and flags set.
- sample.heic: an ISO-BMFF `ftyp heic` header only (format is rejected
  before any parsing).
