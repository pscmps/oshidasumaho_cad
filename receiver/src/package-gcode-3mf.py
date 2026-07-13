import hashlib
import sys
import zipfile


def main():
    if len(sys.argv) != 4:
        print("usage: package-gcode-3mf.py <template.gcode.3mf> <plate_1.gcode> <output.gcode.3mf>", file=sys.stderr)
        return 2

    template_path, gcode_path, output_path = sys.argv[1:]
    gcode = open(gcode_path, "rb").read()
    gcode_md5 = hashlib.md5(gcode).hexdigest().encode("ascii")

    with zipfile.ZipFile(template_path, "r") as src, zipfile.ZipFile(output_path, "w", compression=zipfile.ZIP_DEFLATED) as dst:
        written = set()
        for item in src.infolist():
            name = item.filename
            if name in {"Metadata/plate_1.gcode", "Metadata/plate_1.gcode.md5"}:
                continue
            dst.writestr(item, src.read(name))
            written.add(name)
        dst.writestr("Metadata/plate_1.gcode", gcode)
        dst.writestr("Metadata/plate_1.gcode.md5", gcode_md5)

    print(output_path)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
