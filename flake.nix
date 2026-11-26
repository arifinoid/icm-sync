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

      # hono is the only runtime dependency and it has no dependencies of its
      # own, so pinning the registry tarball is enough to keep the build fully
      # offline: the Nix sandbox cannot resolve DNS, which makes a plain
      # `bun install` fail. The tarball is unpacked as node_modules/hono and
      # bun build bundles it into the standalone binary.
      hono = pkgs: pkgs.stdenv.mkDerivation {
        pname = "hono";
        version = "4.13.22";
        src = pkgs.fetchurl {
          url = "https://registry.npmjs.org/hono/-/hono-4.13.22.tgz";
          hash = "sha256-ZD0ZeLDMmt33iaLGtsZcKo9OCNRn+fpkpGNkHJwPm4k=";
        };
        dontBuild = true;
        installPhase = ''
          mkdir -p "$out/node_modules/hono"
          tar -xzf "$src" -C "$out/node_modules/hono" --strip-components=1
        '';
      };

      # Both entry points are compiled to a standalone executable so the host
      # only needs the binary at runtime (no bun, no node_modules).
      buildBinary =
        pkgs: pname: entrypoint:
        let
          honoPkg = hono pkgs;
        in
        pkgs.stdenv.mkDerivation {
          inherit pname;
          version = "0.1.0";

          src = self;

          nativeBuildInputs = [ pkgs.bun ];

          # bun embeds the bundled script in the ELF itself; stdenv fixup
          # (strip/patchELF) corrupts the payload.
          dontStrip = true;
          dontPatchELF = true;

          buildPhase = ''
            runHook preBuild
            export HOME="$TMPDIR"
            mkdir -p node_modules
            rm -rf node_modules/hono
            ln -s "${honoPkg}/node_modules/hono" node_modules/hono
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
