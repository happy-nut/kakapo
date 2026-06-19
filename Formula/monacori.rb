class Monacori < Formula
  desc "Local review and verification app for AI-generated code changes"
  homepage "https://github.com/happy-nut/monacori"
  url "https://registry.npmjs.org/@happy-nut/monacori/-/monacori-0.1.0.tgz"
  sha256 "16aaa388f654902f9708905ed51fb027f9fcf758a1fb9474cb18f106786776ce"
  license "MIT"

  depends_on "node"

  def install
    system "npm", "install", *std_npm_install_args(libexec)
    bin.install_symlink Dir["#{libexec}/bin/*"]
  end

  test do
    assert_match "monacori", shell_output("#{bin}/monacori --help")
    assert_match "monacori", shell_output("#{bin}/dg --help")
  end
end
