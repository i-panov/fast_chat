declare module "libsodium-wrappers" {
	const sodium: {
		ready: Promise<void>;
		crypto_box_keypair(): { publicKey: Uint8Array; privateKey: Uint8Array };
		to_base64(data: Uint8Array): string;
		from_base64(data: string): Uint8Array;
		randombytes_buf(length: number): Uint8Array;
		crypto_box_seal(message: Uint8Array, publicKey: Uint8Array): Uint8Array;
		crypto_box_seal_open(
			ciphertext: Uint8Array,
			publicKey: Uint8Array,
			privateKey: Uint8Array,
		): Uint8Array;
		crypto_aead_xchacha20poly1305_ietf_KEYBYTES: number;
		crypto_aead_xchacha20poly1305_ietf_NPUBBYTES: number;
		crypto_aead_xchacha20poly1305_ietf_encrypt(
			message: Uint8Array,
			ad: Uint8Array | null,
			secretNonce: Uint8Array | null,
			nonce: Uint8Array,
			key: Uint8Array,
		): Uint8Array;
		crypto_aead_xchacha20poly1305_ietf_decrypt(
			secretNonce: Uint8Array | null,
			ciphertext: Uint8Array,
			ad: Uint8Array | null,
			nonce: Uint8Array,
			key: Uint8Array,
		): Uint8Array;
	};
	export default sodium;
}
