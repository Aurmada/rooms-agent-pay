import { handle } from "../../src/api.js";
export const onRequest = ({ request, env }) => handle(request, env);
