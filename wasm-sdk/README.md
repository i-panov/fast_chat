# Fast Chat WASM SDK

WebAssembly модуль для E2E шифрования и gRPC-Web общения с сервером из браузера.

## Сборка

```bash
wasm-pack build --target web --release
```

## Использование

### Инициализация

```javascript
import init, { CryptoService, ProtoWriter, ProtoReader, GrpcClient } from './pkg/fast_chat_wasm_sdk.js';

await init();
```

### E2E Шифрование

```javascript
// Генерация ключевой пары
const keypairJson = CryptoService.generateKeypair();
const keypair = JSON.parse(keypairJson);
// { public_key: "base64...", private_key: "base64..." }

// Шифрование сообщения
const encryptedJson = CryptoService.encryptMessage(
    "Hello, secret message!",
    recipientPublicKey  // base64-encoded X25519 public key
);
const encrypted = JSON.parse(encryptedJson);
// { encrypted_content: "base64...", nonce: "base64..." }

// Расшифровка
const plaintext = CryptoService.decryptMessage(
    encrypted.encrypted_content,
    encrypted.nonce,
    myPrivateKey
);
```

### gRPC-Web клиент

```javascript
const client = new GrpcClient("http://localhost:8082"); // Envoy gRPC-Web proxy
client.setAuthToken("your-jwt-token");

// === Protobuf encoding ===
const writer = new ProtoWriter();
writer.writeString(1, "admin");     // field 1: username
writer.writeString(2, "admin123");  // field 2: password

// === gRPC-Web call ===
const responseProto = await client.unaryCall("auth.Auth", "Login", writer.toUint8Array());

// === Protobuf decoding ===
const reader = new ProtoReader(responseProto);
while (!reader.isEof()) {
    const tag = reader.readTag();
    const fieldNum = tag >> 3;
    const wireType = tag & 0x7;
    
    if (fieldNum === 1) {
        const accessToken = reader.readString();
    } else if (fieldNum === 2) {
        const refreshToken = reader.readString();
    } else if (fieldNum === 3) {
        const userReader = reader.readMessage();
        // Parse nested User message
        while (!userReader.isEof()) {
            const utag = userReader.readTag();
            const ufield = utag >> 3;
            if (ufield === 2) {
                const username = userReader.readString();
            }
            // ...
        }
    }
}
```

### Доступные gRPC сервисы

| Сервис | Методы |
|--------|--------|
| `auth.Auth` | Register, Login, RefreshToken, GetCurrentUser |
| `users.Users` | GetUser, CreateUser, UpdateUser, DeleteUser, SetAdmin, SetDisabled, Setup2FA, Verify2FA, Enable2FA, Disable2FA |
| `messaging.Messaging` | CreateChat, GetChat, ListChats, ListMessages, SendMessage, etc. |
| `files.Files` | Upload, Download |
| `signaling.Signaling` | StartCall, EndCall, SendIceCandidate, JoinGroupCall |

## Архитектура

```
Browser (WASM)
    │
    └── gRPC-Web ──→ http://envoy:8082 ──→ http://server:50051 (gRPC/HTTP2)
         (proto)        (Envoy proxy)        (Tonic)
```

## API Reference

### CryptoService

| Метод | Описание |
|-------|----------|
| `generateKeypair()` | X25519 ключевая пара → JSON |
| `encryptMessage(content, publicKey)` | ChaCha20Poly1305 + X25519 → JSON |
| `decryptMessage(content, nonce, privateKey)` | Расшифровка → string |
| `deriveSharedSecret(privateKey, publicKey)` | DH shared secret → base64 |

### ProtoWriter / ProtoReader

Минимальный protobuf encoder/decoder для gRPC-Web.

| ProtoWriter | ProtoReader |
|-------------|-------------|
| `writeString(field, value)` | `readString()` |
| `writeBytes(field, data)` | `readBytesField()` |
| `writeBool(field, value)` | `readBool()` |
| `writeInt32(field, value)` | `readInt32()` |
| `writeMessage(field, data)` | `readMessage()` → ProtoReader |
| `toUint8Array()` | `fromBase64(base64)` |

### GrpcClient

| Метод | Описание |
|-------|----------|
| `constructor(baseUrl)` | Envoy gRPC-Web proxy URL |
| `setAuthToken(token)` | JWT токен в localStorage |
| `unaryCall(service, method, proto)` | gRPC-Web unary → Promise<Uint8Array> |

## Безопасность

- Приватные ключи храните только в **IndexedDB** с шифрованием
- E2E шифрование: X25519 + ChaCha20Poly1305
