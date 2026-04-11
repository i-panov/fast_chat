use wasm_bindgen::prelude::*;
use wasm_bindgen_futures::JsFuture;
use web_sys::{Request, RequestInit, RequestMode, Response, Headers};
use js_sys::{Promise, Uint8Array};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};

/// Minimal protobuf message encoder for gRPC-Web.
/// 
/// Supports: strings, bools, ints, bytes, nested messages
#[wasm_bindgen]
pub struct ProtoWriter {
    buf: Vec<u8>,
}

#[wasm_bindgen]
impl ProtoWriter {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Self {
        Self { buf: Vec::new() }
    }

    /// Write a string field
    #[wasm_bindgen(js_name = writeString)]
    pub fn write_string(&mut self, field_number: u32, value: &str) {
        self.write_tag(field_number, 2);
        let bytes = value.as_bytes();
        self.write_varint(bytes.len() as u64);
        self.buf.extend_from_slice(bytes);
    }

    /// Write a bytes field
    #[wasm_bindgen(js_name = writeBytes)]
    pub fn write_bytes(&mut self, field_number: u32, data: &[u8]) {
        self.write_tag(field_number, 2);
        self.write_varint(data.len() as u64);
        self.buf.extend_from_slice(data);
    }

    /// Write a bool field
    #[wasm_bindgen(js_name = writeBool)]
    pub fn write_bool(&mut self, field_number: u32, value: bool) {
        self.write_tag(field_number, 0);
        self.buf.push(if value { 1 } else { 0 });
    }

    /// Write an int32 field
    #[wasm_bindgen(js_name = writeInt32)]
    pub fn write_int32(&mut self, field_number: u32, value: i32) {
        self.write_tag(field_number, 0);
        self.write_varint(value as i64 as u64);
    }

    /// Write an int64 field
    #[wasm_bindgen(js_name = writeInt64)]
    pub fn write_int64(&mut self, field_number: u32, value: i64) {
        self.write_tag(field_number, 0);
        self.write_varint(value as u64);
    }

    /// Write a uint32 field
    #[wasm_bindgen(js_name = writeUint32)]
    pub fn write_uint32(&mut self, field_number: u32, value: u32) {
        self.write_tag(field_number, 0);
        self.write_varint(value as u64);
    }

    /// Write a nested message
    #[wasm_bindgen(js_name = writeMessage)]
    pub fn write_message(&mut self, field_number: u32, message: &[u8]) {
        self.write_tag(field_number, 2);
        self.write_varint(message.len() as u64);
        self.buf.extend_from_slice(message);
    }

    /// Get the encoded bytes as Uint8Array
    #[wasm_bindgen(js_name = toUint8Array)]
    pub fn to_uint8_array(&self) -> Uint8Array {
        let arr = Uint8Array::new_with_length(self.buf.len() as u32);
        arr.copy_from(&self.buf);
        arr
    }

    /// Get the encoded bytes as base64 string
    #[wasm_bindgen(js_name = toBase64)]
    pub fn to_base64(&self) -> String {
        BASE64.encode(&self.buf)
    }

    fn write_tag(&mut self, field_number: u32, wire_type: u8) {
        let tag = (field_number << 3) | wire_type as u32;
        self.write_varint(tag as u64);
    }

    fn write_varint(&mut self, mut value: u64) {
        while value > 0x7F {
            self.buf.push((value as u8) | 0x80);
            value >>= 7;
        }
        self.buf.push(value as u8);
    }
}

/// Minimal protobuf message reader
#[wasm_bindgen]
pub struct ProtoReader {
    buf: Vec<u8>,
    pos: usize,
}

#[wasm_bindgen]
impl ProtoReader {
    #[wasm_bindgen(constructor)]
    pub fn new(data: &[u8]) -> Self {
        Self {
            buf: data.to_vec(),
            pos: 0,
        }
    }

    #[wasm_bindgen(js_name = fromBase64)]
    pub fn from_base64(base64: &str) -> Result<Self, JsError> {
        let buf = BASE64.decode(base64).map_err(|e| JsError::new(&e.to_string()))?;
        Ok(Self { buf, pos: 0 })
    }

    /// Read the next field tag and wire type. Returns (tag, wire_type)
    #[wasm_bindgen(js_name = readTag)]
    pub fn read_tag(&mut self) -> Option<u32> {
        if self.pos >= self.buf.len() {
            return None;
        }
        let (tag, len) = decode_varint(&self.buf[self.pos..])?;
        self.pos += len;
        Some(tag as u32)
    }

    /// Read a string field
    #[wasm_bindgen(js_name = readString)]
    pub fn read_string(&mut self) -> Option<String> {
        let bytes = self.read_bytes_field()?;
        String::from_utf8(bytes).ok()
    }

    /// Read a bytes field
    #[wasm_bindgen(js_name = readBytesField)]
    pub fn read_bytes_field(&mut self) -> Option<Vec<u8>> {
        let len = self.read_varint_value()?;
        if self.pos + len as usize > self.buf.len() {
            return None;
        }
        let data = self.buf[self.pos..self.pos + len as usize].to_vec();
        self.pos += len as usize;
        Some(data)
    }

    /// Read a nested message as ProtoReader
    #[wasm_bindgen(js_name = readMessage)]
    pub fn read_message(&mut self) -> Option<Self> {
        let bytes = self.read_bytes_field()?;
        Some(ProtoReader {
            buf: bytes,
            pos: 0,
        })
    }

    /// Read a bool field
    #[wasm_bindgen(js_name = readBool)]
    pub fn read_bool(&mut self) -> Option<bool> {
        let val = self.read_varint_value()?;
        Some(val != 0)
    }

    /// Read an int32 field
    #[wasm_bindgen(js_name = readInt32)]
    pub fn read_int32(&mut self) -> Option<i32> {
        let val = self.read_varint_value()?;
        Some(val as i32)
    }

    /// Read remaining bytes as base64
    #[wasm_bindgen(js_name = remainingBase64)]
    pub fn remaining_base64(&self) -> String {
        BASE64.encode(&self.buf[self.pos..])
    }

    /// Check if we've read all data
    #[wasm_bindgen(js_name = isEof)]
    pub fn is_eof(&self) -> bool {
        self.pos >= self.buf.len()
    }

    fn read_varint_value(&mut self) -> Option<u64> {
        if self.pos >= self.buf.len() {
            return None;
        }
        let (val, len) = decode_varint(&self.buf[self.pos..])?;
        self.pos += len;
        Some(val)
    }
}

fn decode_varint(buf: &[u8]) -> Option<(u64, usize)> {
    let mut result: u64 = 0;
    let mut shift = 0;
    let mut i = 0;
    for &byte in buf.iter() {
        if i >= 10 {
            return None;
        }
        result |= ((byte & 0x7F) as u64) << shift;
        i += 1;
        if byte & 0x80 == 0 {
            return Some((result, i));
        }
        shift += 7;
    }
    None
}

/// gRPC-Web client for communicating with the Fast Chat server via Envoy proxy.
/// 
/// Sends real gRPC-Web requests with protobuf serialization.
#[wasm_bindgen]
pub struct GrpcClient {
    base_url: String,
}

#[wasm_bindgen]
impl GrpcClient {
    /// Create a new gRPC-Web client
    /// 
    /// # Arguments
    /// * `base_url` - URL of the Envoy gRPC-Web proxy (e.g., "http://localhost:8082")
    #[wasm_bindgen(constructor)]
    pub fn new(base_url: &str) -> Self {
        let url = base_url.trim_end_matches('/');
        Self {
            base_url: url.to_string(),
        }
    }

    /// Get the base URL
    #[wasm_bindgen(getter, js_name = baseUrl)]
    pub fn base_url(&self) -> String {
        self.base_url.clone()
    }

    /// Set the authorization token (stored in localStorage)
    #[wasm_bindgen(js_name = setAuthToken)]
    pub fn set_auth_token(&self, token: &str) {
        if let Some(window) = web_sys::window() {
            if let Ok(Some(storage)) = window.local_storage() {
                let _ = storage.set_item("auth_token", token);
            }
        }
    }

    /// Get the stored authorization token
    #[wasm_bindgen(js_name = getAuthToken)]
    pub fn get_auth_token() -> Option<String> {
        let window = web_sys::window()?;
        let storage = window.local_storage().ok()??;
        storage.get_item("auth_token").ok().flatten()
    }

    /// Clear the stored authorization token
    #[wasm_bindgen(js_name = clearAuthToken)]
    pub fn clear_auth_token() {
        if let Some(window) = web_sys::window() {
            if let Ok(Some(storage)) = window.local_storage() {
                let _ = storage.remove_item("auth_token");
            }
        }
    }

    /// Make a unary gRPC-Web call.
    /// 
    /// # Arguments
    /// * `service` - gRPC service name (e.g., "auth.Auth")
    /// * `method` - RPC method name (e.g., "Login")
    /// * `request_proto` - Protobuf-encoded request as Uint8Array
    /// 
    /// Returns a Promise that resolves to Uint8Array (protobuf-encoded response)
    #[wasm_bindgen(js_name = unaryCall)]
    pub fn unary_call(&self, service: &str, method: &str, request_proto: &[u8]) -> Promise {
        let url = format!("{}/{}//{}", self.base_url, service, method);
        let request_proto = request_proto.to_vec();

        wasm_bindgen_futures::future_to_promise(async move {
            // Build gRPC-Web request body
            // Format: 1 byte (0x00 = data) + 4 bytes (length big-endian) + protobuf payload
            let mut body = Vec::with_capacity(5 + request_proto.len());
            body.push(0x00); // data frame
            body.extend_from_slice(&(request_proto.len() as u32).to_be_bytes());
            body.extend_from_slice(&request_proto);

            let headers = Headers::new().map_err(|e| JsError::new(&format!("Headers: {:?}", e)))?;
            headers.set("Content-Type", "application/grpc-web+proto").map_err(|e| JsError::new(&format!("Content-Type: {:?}", e)))?;
            headers.set("X-Grpc-Web", "1").map_err(|e| JsError::new(&format!("X-Grpc-Web: {:?}", e)))?;
            headers.set("X-User-Agent", "grpc-web-wasm/0.1.0").map_err(|e| JsError::new(&format!("X-User-Agent: {:?}", e)))?;
            headers.set("TE", "trailers").map_err(|e| JsError::new(&format!("TE: {:?}", e)))?;

            if let Some(token) = Self::get_auth_token() {
                headers.set("Authorization", &format!("Bearer {}", token))
                    .map_err(|e| JsError::new(&format!("Auth: {:?}", e)))?;
            }

            let mut opts = RequestInit::new();
            opts.set_method("POST");
            opts.set_headers(&headers);
            opts.set_mode(RequestMode::Cors);
            opts.set_body(&JsValue::from(Uint8Array::from(&body[..])));

            let request = Request::new_with_str_and_init(&url, &opts)
                .map_err(|e| JsError::new(&format!("Request: {:?}", e)))?;

            let window = web_sys::window().ok_or_else(|| JsError::new("No window"))?;
            let resp_value = JsFuture::from(window.fetch_with_request(&request))
                .await
                .map_err(|e| JsError::new(&format!("Fetch: {:?}", e)))?;

            let response: Response = resp_value.dyn_into()
                .map_err(|_| JsError::new("Response parse"))?;

            let status = response.status();

            // Get response as ArrayBuffer
            let buffer = JsFuture::from(response.array_buffer().map_err(|_| JsError::new("No buffer"))?)
                .await
                .map_err(|e| JsError::new(&format!("Buffer: {:?}", e)))?;

            let uint8 = Uint8Array::new(&buffer);
            let len = uint8.byte_length() as usize;

            if len < 5 {
                if status != 200 {
                    return Err(JsError::new(&format!("HTTP {}", status)).into());
                }
                let arr = Uint8Array::new_with_length(0);
                return Ok(arr.into());
            }

            // Read frame type using indexed access
            let frame_type_vec = uint8.to_vec();
            let frame_type = frame_type_vec[0];

            if frame_type != 0x00 {
                return Err(JsError::new(&format!("Unexpected frame type: 0x{:02x}", frame_type)).into());
            }

            // Read data length
            let data_len = u32::from_be_bytes([
                frame_type_vec[1],
                frame_type_vec[2],
                frame_type_vec[3],
                frame_type_vec[4],
            ]) as usize;

            if len < 5 + data_len {
                return Err(JsError::new(&format!("Incomplete response: expected {} bytes, got {}", 5 + data_len, len)).into());
            }

            // Extract protobuf data
            let proto_data = uint8.slice(5, (5 + data_len) as u32);

            // Check for trailers with grpc-status
            if len > 5 + data_len && frame_type_vec[5 + data_len] == 0x80 {
                let trailer_start = 5 + data_len + 5;
                if trailer_start < len {
                    let trailer_len_vec = uint8.slice((5 + data_len + 1) as u32, (5 + data_len + 5) as u32).to_vec();
                    let trailer_len = u32::from_be_bytes([
                        trailer_len_vec[0],
                        trailer_len_vec[1],
                        trailer_len_vec[2],
                        trailer_len_vec[3],
                    ]) as usize;

                    if trailer_start + trailer_len <= len {
                        let trailer_data = uint8.slice(trailer_start as u32, (trailer_start + trailer_len) as u32);
                        if let Ok(trailer_str) = String::from_utf8(trailer_data.to_vec()) {
                            if let Some(status_line) = trailer_str.lines().find(|l| l.starts_with("grpc-status:")) {
                                let grpc_status: i32 = status_line.trim_start_matches("grpc-status:").parse().unwrap_or(0);
                                if grpc_status != 0 {
                                    let grpc_msg = trailer_str.lines()
                                        .find(|l| l.starts_with("grpc-message:"))
                                        .map(|l| l.trim_start_matches("grpc-message:").to_string())
                                        .unwrap_or_else(|| format!("gRPC error: {}", grpc_status));
                                    return Err(JsError::new(&grpc_msg).into());
                                }
                            }
                        }
                    }
                }
            }

            Ok(JsValue::from(proto_data))
        })
    }
}
