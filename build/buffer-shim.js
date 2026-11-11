// Node's Buffer for the browser bundle (the SDK's encrypted relay uses Buffer.from).
import { Buffer } from 'buffer';
if (!globalThis.Buffer) globalThis.Buffer = Buffer;
export { Buffer };
