# One VPC, one public subnet, no SSH port: shell access is Systems Manager (I6, I7).
resource "aws_vpc" "main" {
  cidr_block           = "10.20.0.0/16"
  enable_dns_support   = true
  enable_dns_hostnames = true
  tags                 = { Name = "kestrel" }
}

resource "aws_internet_gateway" "main" {
  vpc_id = aws_vpc.main.id
  tags   = { Name = "kestrel" }
}

resource "aws_subnet" "public" {
  vpc_id                  = aws_vpc.main.id
  cidr_block              = "10.20.1.0/24"
  availability_zone       = var.availability_zone
  map_public_ip_on_launch = true
  tags                    = { Name = "kestrel-public" }
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.main.id
  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.main.id
  }
  tags = { Name = "kestrel-public" }
}

resource "aws_route_table_association" "public" {
  subnet_id      = aws_subnet.public.id
  route_table_id = aws_route_table.public.id
}

resource "aws_security_group" "host" {
  name        = "kestrel-host"
  description = "Kestrel host: web, certificate issuance and the gateways. No SSH."
  vpc_id      = aws_vpc.main.id

  tags = { Name = "kestrel-host" }
}

locals {
  inbound_ports = merge(
    {
      80   = "certificate issuance (HTTP-01) and redirect"
      443  = "the API, via Caddy"
      8443 = "gateway, node a"
    },
    var.open_node_b_port ? { 8444 = "gateway, node b (tests only)" } : {},
  )
}

resource "aws_vpc_security_group_ingress_rule" "inbound" {
  for_each          = local.inbound_ports
  security_group_id = aws_security_group.host.id
  description       = each.value
  ip_protocol       = "tcp"
  from_port         = each.key
  to_port           = each.key
  cidr_ipv4         = "0.0.0.0/0"
}

resource "aws_vpc_security_group_egress_rule" "all" {
  security_group_id = aws_security_group.host.id
  description       = "Outbound: package repositories, image registries, certificate authority, the public web for sessions"
  ip_protocol       = "-1"
  cidr_ipv4         = "0.0.0.0/0"
}
