{
  description = "Two-way memory sync for ICM (Infinite Context Memory)";

  inputs.nixpkgs.url = "github:nixos/nixpkgs/nixos-unstable";

  outputs =
    {
      self,
      nixpkgs,
    }:
    let
      systems = [
        "aarch64-darwin"
        "aarch64-linux"
        "x86_64-linux"
      ];

      forAllSystems = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});

      # Both entry points are compiled to a standalone executable so the host
      # only needs the binary at runtime (no bun, no node_modules).
      buildBinary =
        pkgs: pname: entrypoint:
        pkgs.stdenv.mkDerivation {
          inherit pname;
          version = "0.1.0";

          src = self;

          nativeBuildInputs = [ pkgs.bun ];

          buildPhase = ''
            runHook preBuild
            export HOME="$TMPDIR"
            bun install --frozen-lockfile
            bun build "${entrypoint}" --compile --outfile "${pname}"
            runHook postBuild
          '';

          installPhase = ''
            runHook preInstall
            install -Dt "$out/bin" "${pname}"
            runHook postInstall
          '';
        };
    in
    {
      packages = forAllSystems (pkgs: {
        api = buildBinary pkgs "icm-sync-api" "src/api/index.ts";
        sync = buildBinary pkgs "icm-sync" "src/sync/index.ts";
        default = buildBinary pkgs "icm-sync-api" "src/api/index.ts";
      });
    };
}
