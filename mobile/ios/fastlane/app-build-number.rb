# xcodebuild command-line settings apply to EVERY project in a workspace.
# Stamp only the app project while archiving, then restore the source exactly.
module SingzAppBuildNumber
  def self.with_number(project, number)
    raise ArgumentError, 'build number must be a positive integer' unless number.to_s.match?(/\A[1-9]\d*\z/)
    original = File.read(project)
    raise ArgumentError, 'app project has no build number' unless original.match?(/CURRENT_PROJECT_VERSION = \d+;/)
    stamped = original.gsub(/CURRENT_PROJECT_VERSION = \d+;/, "CURRENT_PROJECT_VERSION = #{number};")
    File.write(project, stamped) unless stamped == original
    begin
      yield
    ensure
      # Do not silently discard another editor's changes during an archive.
      if File.read(project) == stamped
        File.write(project, original) unless stamped == original
      else
        warn 'App project changed during archive; preserving those edits instead of restoring the build number.'
      end
    end
  end
end
