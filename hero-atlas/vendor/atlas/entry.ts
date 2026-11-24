// Bundles the Atlas gazetteer, shapes and grading helpers into a browser global.
// Rebuild with: npm run build:atlas   (writes js/28-atlas-geo.js)
import { GAZETTEER, lookupGazetteer, toResolved } from "./gazetteer";
import { SHAPES } from "./shapes";
import * as geo from "./geo";
import { EXAMPLE_SET, resolveExampleLocations } from "./exampleSet";
(window as any).AtlasGeo = { GAZETTEER, lookupGazetteer, toResolved, SHAPES, EXAMPLE_SET, resolveExampleLocations, ...geo };
