import type { SerialPortListResponse } from "../../deviceConnectionApi";

export function listResponse(ports: SerialPortListResponse["ports"]): SerialPortListResponse {
  return {
    status: { code: "LIST_PORTS_OK", message: "ok", details: null },
    ports,
  };
}
