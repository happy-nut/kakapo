import com.intellij.execution.filters.ExceptionWorker;
import com.intellij.openapi.util.TextRange;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.*;

public class StackTraceOracle {
  static String esc(String s) {
    StringBuilder b = new StringBuilder();
    for (char c : s.toCharArray()) {
      if (c == '"' || c == '\\') b.append('\\').append(c);
      else if (c == '\n') b.append("\\n");
      else if (c == '\r') b.append("\\r");
      else if (c == '\t') b.append("\\t");
      else if (c < 0x20) b.append(String.format("\\u%04x", (int) c));
      else b.append(c);
    }
    return b.toString();
  }
  static String range(String line, TextRange r) {
    if (r == null) return "null";
    return "{\"start\":" + r.getStartOffset() + ",\"end\":" + r.getEndOffset()
      + ",\"text\":\"" + esc(r.getStartOffset() >= 0 && r.getEndOffset() <= line.length() && r.getStartOffset() <= r.getEndOffset() ? r.substring(line) : "") + "\"}";
  }
  public static void main(String[] args) throws Exception {
    List<String> lines = Files.readAllLines(Paths.get(args[0]), StandardCharsets.UTF_8);
    StringBuilder out = new StringBuilder("[\n");
    for (int i = 0; i < lines.size(); i++) {
      String line = lines.get(i);
      if (line.startsWith("#SKIP")) continue;
      String decoded = line.replace("\\t", "\t");
      ExceptionWorker.ParsedLine p;
      String err = null;
      try { p = ExceptionWorker.parseExceptionLine(decoded); }
      catch (Throwable t) { p = null; err = t.getClass().getSimpleName() + ": " + t.getMessage(); }
      out.append(out.length() > 2 ? ",\n" : "");
      out.append("  {\"line\":\"").append(esc(decoded)).append("\"");
      if (err != null) out.append(",\"error\":\"").append(esc(err)).append("\"");
      if (p == null) out.append(",\"frame\":false}");
      else {
        out.append(",\"frame\":true")
           .append(",\"classFqn\":").append(range(decoded, p.classFqnRange))
           .append(",\"method\":").append(range(decoded, p.methodNameRange))
           .append(",\"fileLine\":").append(range(decoded, p.fileLineRange))
           .append(",\"fileName\":").append(p.fileName == null ? "null" : "\"" + esc(p.fileName) + "\"")
           .append(",\"lineNumber\":").append(p.lineNumber)
           .append("}");
      }
    }
    out.append("\n]\n");
    System.out.print(out);
  }
}
