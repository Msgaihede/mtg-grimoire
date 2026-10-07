import java.nio.file.FileSystem;
import java.nio.file.FileSystems;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

/**
 * Removes a JAR signature from an archive, in place: `META-INF/MANIFEST.MF` and every
 * `META-INF/*.SF`, `*.RSA`, `*.DSA`, `*.EC` and `SIG-*`. Every other entry is left as it is.
 *
 *   java StripSignature.java <archive>
 */
public class StripSignature {
    public static void main(String[] args) throws Exception {
        if (args.length != 1) {
            System.err.println("usage: java StripSignature.java <archive>");
            System.exit(2);
        }
        List<String> removed = new ArrayList<>();
        try (FileSystem zip = FileSystems.newFileSystem(Path.of(args[0]))) {
            Path meta = zip.getPath("META-INF");
            if (Files.isDirectory(meta)) {
                List<Path> doomed = new ArrayList<>();
                try (var entries = Files.newDirectoryStream(meta)) {
                    for (Path entry : entries) {
                        if (Files.isRegularFile(entry) && isSignature(entry.getFileName().toString())) {
                            doomed.add(entry);
                        }
                    }
                }
                for (Path entry : doomed) {
                    Files.delete(entry);
                    removed.add(entry.toString());
                }
            }
        }
        System.out.println("removed " + removed.size() + " signature entries: " + String.join(" ", removed));
    }

    private static boolean isSignature(String file) {
        String name = file.toUpperCase(Locale.ROOT);
        return name.equals("MANIFEST.MF")
                || name.startsWith("SIG-")
                || name.endsWith(".SF")
                || name.endsWith(".RSA")
                || name.endsWith(".DSA")
                || name.endsWith(".EC");
    }
}
