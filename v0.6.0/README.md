# BimCraft 0.6: browser edition

Open the model. Check it. Change it.

BimCraft is the BIM review & editing app in the CadCraft family. This folder is the whole app as plain files: put it on any web server and open it in your browser. Your files stay on your computer: nothing is uploaded, and the app never contacts getcadcraft.com.

1. **Get it:** the zip `bimcraft-browser-edition-v0.6.0.zip` from https://github.com/getcadcraft/bimcraft/releases, or this folder from a clone of https://github.com/getcadcraft/bimcraft.
2. **Put it on a web server:** any folder of any web server. On your own computer, run `python3 -m http.server 8000` (or `php -S localhost:8000`, or `npx serve .`) inside this folder.
3. **Open it:** the folder's address in your browser, for example http://localhost:8000/. Press F1 for help.

Double-clicking `index.html` does not work: browsers do not run apps like this from `file://` addresses. Servers, troubleshooting, updating and removing: see [INSTALL.md](INSTALL.md).

## License

Apache License 2.0 (`LICENSE`, `NOTICE`). Libraries and their licenses: `THIRD_PARTY.md`. Where our code comes from: `PROVENANCE.md`. The CadCraft names are trademarks; a fork must use another name ([TRADEMARKS.md](TRADEMARKS.md)).

---
CadCraft and the CadCraft logo are trademarks of The Data Design Group, Inc. AutoCAD, Revit and Civil 3D are registered trademarks of Autodesk, Inc. SketchUp and Tekla are trademarks of Trimble Inc. Bluebeam is a trademark of Bluebeam, Inc. PlanSwift is a trademark of ConstructConnect. SolidWorks is a registered trademark of Dassault Systèmes. All other company and product names, logos and brands are the property of their respective owners and are used only to identify their products. CadCraft is independent and not affiliated with, sponsored by or endorsed by any of them.
