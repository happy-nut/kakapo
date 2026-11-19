import json, sys, xml.etree.ElementTree as ET, zipfile

FONT = {None: "plain", "0": "plain", "1": "bold", "2": "italic", "3": "bold+italic"}
EFFECT = {None: "none", "1": "underline", "2": "wavy", "3": "strikeout",
          "4": "bold-underline", "5": "bold-dotted", "6": "dotted"}
DEFAULT_FOREGROUND = {"Darcula": "a9b7c6", "Default": "000000"}


def schemes(jar_path):
    with zipfile.ZipFile(jar_path) as jar:
        root = ET.fromstring(jar.read("DefaultColorSchemesManager.xml"))
    out = {}
    for scheme in root.iter("scheme"):
        attributes = {}
        for option in scheme.findall("./attributes/option"):
            value = option.find("value")
            if value is None:
                continue
            attributes[option.get("name")] = {o.get("name"): o.get("value") for o in value.findall("option")}
        out[scheme.get("name")] = attributes
    return out


def look(attributes, fallback):
    return " / ".join([
        attributes.get("FOREGROUND") or fallback,
        FONT.get(attributes.get("FONT_TYPE"), "plain"),
        EFFECT.get(attributes.get("EFFECT_TYPE"), "none"),
    ])


def main(jar_path, out_path):
    report = {}
    for name, attributes in schemes(jar_path).items():
        fallback = DEFAULT_FOREGROUND.get(name, "000000")
        report[name] = {key: look(value, fallback) for key, value in sorted(attributes.items())}
    with open(out_path, "w") as handle:
        json.dump(report, handle, indent=1, sort_keys=True)
    for name, looks in report.items():
        platform = {k: v for k, v in looks.items() if k.startswith("DEFAULT_")}
        print(f"{name}: {len(looks)} keys, {len(platform)} platform keys, "
              f"{len(set(platform.values()))} distinct looks, "
              f"{len({v.split(' / ')[0] for v in platform.values()})} distinct colours")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
