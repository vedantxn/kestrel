output "instance_id" {
  value = aws_instance.host.id
}

output "public_ip" {
  value = data.aws_eip.host.public_ip
}

output "hostname" {
  value = local.hostname
}

output "test_page_url" {
  value = "https://${aws_s3_bucket.testpage.bucket_regional_domain_name}/${aws_s3_object.index.key}"
}

output "data_volume_id" {
  value = aws_ebs_volume.data.id
}
