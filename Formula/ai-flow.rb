class AiFlow < Formula
  desc "Local review and verification app for AI-generated code changes"
  homepage "https://github.com/happy-nut/ai-flow"
  url "https://registry.npmjs.org/ai-flow/-/ai-flow-0.1.0.tgz"
  sha256 "f8d71bf4eac7f560be2342c34e1a8a130eea3a66da868870250e7e468229dd58"
  license "MIT"

  depends_on "node"

  def install
    system "npm", "install", *std_npm_install_args(libexec)
    bin.install_symlink Dir["#{libexec}/bin/*"]
  end

  test do
    assert_match "ai-flow", shell_output("#{bin}/ai-flow --help")
    assert_match "ai-flow", shell_output("#{bin}/aif --help")
  end
end
