// Minimal Cookie-header parser for the WebSocket handshake — Socket.IO's
// handshake doesn't run through Express's cookie-parser middleware, so
// MessagingGateway reads socket.handshake.headers.cookie directly.
// Hand-written (a few lines) rather than adding the `cookie` npm package
// as a new dependency for something this small — same minimalism
// precedent as this codebase's existing sha256/generateOpaqueToken utils.
export function parseCookieHeader(header: string): Record<string, string> {
  const cookies: Record<string, string> = {};
  for (const pair of header.split(';')) {
    const separatorIndex = pair.indexOf('=');
    if (separatorIndex === -1) {
      continue;
    }
    const key = pair.slice(0, separatorIndex).trim();
    const value = pair.slice(separatorIndex + 1).trim();
    if (key) {
      try {
        cookies[key] = decodeURIComponent(value);
      } catch {
        cookies[key] = value;
      }
    }
  }
  return cookies;
}
