plugins {
    kotlin("jvm") version "2.2.0"
    id("org.jetbrains.intellij.platform") version "2.20.1"
}

repositories {
    mavenCentral()
    intellijPlatform { defaultRepositories() }
}

dependencies {
    testImplementation(kotlin("test"))
    intellijPlatform {
        intellijIdeaCommunity("2025.2")
        pluginVerifier()
    }
}

kotlin { jvmToolchain(21) }

group = "dev.kakapo"
version = "0.0.3"

val releaseNotes: (String) -> String = { released ->
    val changelog = file("CHANGELOG.md").readText()
    val heading = Regex("(?m)^## \\Q$released\\E\\s*$").find(changelog)
        ?: error("CHANGELOG.md has no '## $released' section, so $released would ship the previous version's notes")
    val rest = changelog.substring(heading.range.last + 1)
    val next = Regex("(?m)^## ").find(rest)
    (if (next == null) rest else rest.substring(0, next.range.first)).trim()
}

val marketplaceToken: Provider<String> = providers
    .environmentVariable("JETBRAINS_MARKETPLACE_TOKEN")
    .orElse(providers.provider {
        val stored = File(System.getProperty("user.home"), ".config/kakapo/jetbrains-marketplace-token")
        if (stored.isFile) stored.readText().trim() else null
    })

intellijPlatform {
    pluginConfiguration {
        name = "kakapo comments"
        description = """
            <p>Write a review comment where the caret is — in the editor or in the Diff window — and hand
            the whole review to a coding agent with one copy.</p>
            <p>Comments are kept in the repository's own <code>.git/kakapo/comments.jsonl</code>, the file
            the <a href="https://github.com/happy-nut/kakapo">kakapo</a> desktop reader uses, so a comment
            written in the IDE opens there and one written there is marked in the IDE's gutter.</p>
            <p>A comment stores the text of the line it was written on, so it still points at the right
            line after an agent has edited the file from outside the IDE.</p>
        """.trimIndent()
        version = project.version.toString()
        changeNotes = releaseNotes(project.version.toString())
        ideaVersion {
            sinceBuild = "252"
            untilBuild = provider { null }
        }
    }

    publishing {
        token = marketplaceToken
        channels = listOf("default")
    }
}


tasks.named("buildSearchableOptions") { enabled = false }

intellijPlatform {
    pluginVerification {
        ides {
            select {
                types = listOf(org.jetbrains.intellij.platform.gradle.IntelliJPlatformType.IntellijIdeaCommunity)
                sinceBuild = "252"
                untilBuild = "252.*"
            }
        }
    }
}

tasks.register<JavaExec>("anchorCheck") {
    group = "verification"
    description = "The anchor rule, checked without an IDE: it is plain Kotlin on purpose."
    mainClass = "dev.kakapo.comments.AnchorCheck"
    classpath = sourceSets["main"].output + configurations["runtimeClasspath"]
    javaLauncher = javaToolchains.launcherFor { languageVersion = JavaLanguageVersion.of(21) }
}
