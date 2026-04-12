import { vi } from "vitest";
import "libsodium-wrappers";

// @ts-ignore
global.sodium = {
    crypto_box_keypair: () => ({
        publicKey: new Uint8Array(32),
        privateKey: new Uint8Array(32),
    }),
    crypto_box: () => new Uint8Array(64),
    crypto_box_open: () => new Uint8Array(10),
};

// Mock nacl
vi.mock("tweetnacl", () => ({
    box: {
        keyPair: () => ({
            publicKey: new Uint8Array(32),
            secretKey: new Uint8Array(32),
        }),
        before: () => new Uint8Array(32),
        after: () => new Uint8Array(32),
        open: (_ct: any, _nonce: any, _publicKey: any, _secretKey: any) =>
            new Uint8Array(10),
    },
    randomBytes: (len: number) => new Uint8Array(len),
    nonceLength: 24,
    overheadLength: 16,
}));

vi.mock("tweetnacl-util", () => ({
    encodeUTF8: (str: string) => new TextEncoder().encode(str),
    decodeUTF8: (arr: Uint8Array) => new TextDecoder().decode(arr),
    encodeBase64: (arr: Uint8Array) => btoa(String.fromCharCode(...arr)),
    decodeBase64: (str: string) =>
        new Uint8Array(
            atob(str)
                .split("")
                .map((c) => c.charCodeAt(0)),
        ),
}));
