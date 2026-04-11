fn main() -> Result<(), Box<dyn std::error::Error>> {
    let proto_files = &[
        "../proto/common.proto",
        "../proto/auth.proto",
        "../proto/users.proto",
        "../proto/messaging.proto",
        "../proto/files.proto",
        "../proto/signaling.proto",
    ];

    tonic_build::configure()
        .build_server(true)
        .build_client(true)
        .out_dir("src/proto")
        .type_attribute(".", "#[allow(dead_code)]")
        .compile_protos(proto_files, &["../proto"])?;

    Ok(())
}
