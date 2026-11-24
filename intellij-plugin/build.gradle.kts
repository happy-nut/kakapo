plugins {
    kotlin("jvm") version "2.2.0"
    id("org.jetbrains.intellij.platform") version "2.1.0"
}

repositories {
    mavenCentral()
    intellijPlatform { defaultRepositories() }
}

dependencies {
    testImplementation(kotlin("test"))
    intellijPlatform {
        intellijIdeaCommunity("2025.2")
        instrumentationTools()
        pluginVerifier()
    }
}

kotlin { jvmToolchain(21) }

group = "dev.kakapo"
version = "0.0.1"

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
        changeNotes = """
            First release: a review comment at the caret, in the editor and in the Diff window, kept in
            the repository's own .git/kakapo/comments.jsonl so kakapo and the IDE read one review.
        """.trimIndent()
        ideaVersion {
            sinceBuild = "252"
            untilBuild = provider { null }
        }
    }

    publishing {
        token = providers.environmentVariable("JETBRAINS_MARKETPLACE_TOKEN")
        channels = listOf("default")
    }
}


tasks.named("buildSearchableOptions") { enabled = false }

intellijPlatform {
    pluginVerification {
        ides {
            ide(org.jetbrains.intellij.platform.gradle.IntelliJPlatformType.IntellijIdeaCommunity, "2025.2")
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
