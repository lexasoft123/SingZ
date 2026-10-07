require 'minitest/autorun'

# Execute the real lane bodies with store actions replaced by recording fakes.
# No credentials, archives or network calls are used by this suite.
class ReviewPipelineHarness
  module UI
    def self.important(*) = nil
    def self.success(*) = nil
  end

  attr_accessor :groups, :upload_failure, :contact_failure, :open_review
  attr_reader :events

  def initialize
    @events = []
    @groups = []
  end

  def default_platform(*) = nil
  def platform(*) = yield
  def desc(*) = nil
  def lane(name, &block)
    self.class.define_method(name) { |options = {}| instance_exec(options, &block) }
  end
  alias private_lane lane
end

fastfile = File.expand_path('../Fastfile', __dir__)
ReviewPipelineHarness.new.instance_eval(File.read(fastfile), fastfile)

class ReviewPipelineHarness
  # Override helpers after registering the real lane bodies.
  def verify_marketing_version = '0.26.1'
  def ci_build_number = 30
  def api_key = :test_key
  def testflight_groups = groups
  def review_contact
    raise 'Missing contact' if contact_failure
    events << :contact_checked
    { first_name: 'Test' }
  end
  def in_progress_review_submission = open_review
  def refuse_if_review_in_progress
    events << :review_checked
    raise 'Review already open' if open_review
  end
  def beta_review_info = {}
  def install_signing(**) = events << :signing
  def archive(**) = (events << :archive; 'test.ipa')
  def sync_release_notes(**) = nil
  def external_changelog(*) = 'Release notes'
  def upload_to_testflight(**options)
    events << [:upload, options]
    raise 'Upload failed' if upload_failure
    events << :processed unless options[:skip_waiting_for_build_processing]
  end
  def upload_to_app_store(**options) = events << [:submit, options]
end

class ReviewPipelineTest < Minitest::Test
  def setup = @pipeline = ReviewPipelineHarness.new

  def submissions = @pipeline.events.select { |e| e.is_a?(Array) && e[0] == :submit }
  def uploads = @pipeline.events.select { |e| e.is_a?(Array) && e[0] == :upload }

  def test_tag_ship_waits_and_submits_same_build_without_external_group
    @pipeline.ship
    assert_equal false, uploads.first[1][:skip_waiting_for_build_processing]
    assert_equal false, uploads.first[1][:distribute_external]
    assert_equal 1, submissions.size
    assert_equal '30', submissions.first[1][:build_number]
    assert_equal '0.26.1', submissions.first[1][:app_version]
    assert_equal true, submissions.first[1][:submit_for_review]
    assert_equal false, submissions.first[1][:automatic_release]
    assert_operator @pipeline.events.index(:processed), :<, @pipeline.events.index(submissions.first)
    assert_operator @pipeline.events.index(:contact_checked), :<, @pipeline.events.index(:archive)
    assert_operator @pipeline.events.index(:review_checked), :<, @pipeline.events.index(:archive)
  end

  def test_tag_ship_keeps_external_testflight_distribution
    @pipeline.groups = ['External Testers']
    @pipeline.ship
    assert_equal false, uploads.first[1][:skip_waiting_for_build_processing]
    assert_equal true, uploads.first[1][:distribute_external]
    assert_equal ['External Testers'], uploads.first[1][:groups]
    assert_equal 1, submissions.size
    assert_equal 1, @pipeline.events.count(:archive)
  end


  def test_tag_ship_uploads_during_app_store_review_without_touching_submission
    @pipeline.open_review = Struct.new(:state, :app_store_version_for_review).new('WAITING_FOR_REVIEW', nil)
    @pipeline.groups = ['External Testers']
    @pipeline.contact_failure = true
    @pipeline.ship
    assert_equal 1, uploads.size
    assert_equal false, uploads.first[1][:skip_waiting_for_build_processing]
    assert_equal true, uploads.first[1][:distribute_external]
    assert_empty submissions
    refute_includes @pipeline.events, :review_checked
    refute_includes @pipeline.events, :contact_checked
  end

  def test_tag_ship_uploads_internal_build_during_review
    @pipeline.open_review = Struct.new(:state, :app_store_version_for_review).new('IN_REVIEW', nil)
    @pipeline.ship
    assert_equal 1, uploads.size
    assert_equal false, uploads.first[1][:distribute_external]
    assert_empty submissions
  end

  def test_manual_store_submission_still_refuses_an_open_review
    @pipeline.open_review = Object.new
    assert_raises(RuntimeError) { @pipeline.submit(build: 30) }
    assert_empty submissions
    assert_empty uploads
  end

  def test_manual_beta_remains_upload_only
    @pipeline.beta
    assert_equal true, uploads.first[1][:skip_waiting_for_build_processing]
    assert_empty submissions
  end

  def test_failed_upload_never_submits_for_review
    @pipeline.upload_failure = true
    assert_raises(RuntimeError) { @pipeline.ship }
    assert_empty submissions
  end

  def test_missing_review_contact_fails_before_build_or_upload
    @pipeline.contact_failure = true
    assert_raises(RuntimeError) { @pipeline.ship }
    refute_includes @pipeline.events, :archive
    assert_empty uploads
    assert_empty submissions
  end
end
