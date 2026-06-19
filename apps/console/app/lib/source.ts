import { loader } from "fumadocs-core/source";
import { docs } from "../../.source";

export const source = loader({
  source: docs.toFumadocsSource(),
  baseUrl: "/docs",
});
